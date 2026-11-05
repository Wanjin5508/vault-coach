import { EmbeddingError } from "../../domain/embedding/embedding-error";
import type {
    LocalAiEmbeddingRequest,
    LocalAiEmbeddingResult,
    LocalAiRerankRequest,
    LocalAiRerankResult,
    LocalAiRole,
    LocalAiStatus,
    LocalAIRerankerRuntimePort,
    LocalAIRuntimePort,
} from "../../domain/local-ai/local-ai-types";
import type { RuntimeAssetStore } from "../../domain/local-ai/local-ai-runtime-assets";
import { BUILTIN_EMBEDDING_POLICY, BUILTIN_RERANK_POLICY } from "./model-registry";
import { LocalAiScheduler, type LocalAiPriority } from "./local-ai-scheduler";
import {
    LOCAL_AI_WORKER_PROTOCOL_VERSION,
    parseLocalAiWorkerMessage,
    type LocalAiWorkerOperation,
    type LocalAiWorkerRequest,
} from "../../infrastructure/local-ai/local-ai-worker-protocol";
import { createIndexTraceRef, type IndexLifecycleTrace } from "../observability/index-lifecycle-trace";

declare const __VAULT_COACH_LOCAL_AI_WORKER_SOURCE__: string;

interface PendingRequest {
    jobId: string;
    workerEpoch: number;
    role: LocalAiRole;
    policyId: string;
    resolve(value: unknown): void;
    reject(reason: unknown): void;
    cleanup(): void;
}

export interface LocalAiWorkerHandle {
    worker: Worker;
    objectUrl: string | null;
}

export type LocalAiWorkerFactory = () => LocalAiWorkerHandle;

/** 一个插件生命周期只创建一个 Worker；所有模型状态和请求通过该边界串行化。 */
export class LocalAIRuntime implements LocalAIRuntimePort, LocalAIRerankerRuntimePort {
    private worker: Worker | null = null;
    private workerUrl: string | null = null;
    private workerEpoch = 0;
    private requestSequence = 0;
    private readonly pending = new Map<string, PendingRequest>();
    private readonly scheduler = new LocalAiScheduler();
    private readonly listeners = new Set<(status: LocalAiStatus) => void>();
    private prepareTask: Promise<void> | null = null;
    private rerankerPrepareTask: Promise<void> | null = null;
    private activeRole: LocalAiRole | null = null;
    private disposed = false;
    private status: LocalAiStatus = {
        role: "embedding", phase: "not-installed", progress: null, message: null, cached: false, backend: "wasm",
    };
    private rerankerStatus: LocalAiStatus = {
        role: "reranker", phase: "not-installed", progress: null, message: null, cached: false, backend: "wasm",
    };

    constructor(
        private readonly runtimeAssets: RuntimeAssetStore,
        private readonly createWorker: LocalAiWorkerFactory = createEmbeddedWorker,
        private readonly trace?: IndexLifecycleTrace,
    ) {}

    getStatus(): LocalAiStatus { return { ...this.status }; }

    getRerankerStatus(): LocalAiStatus { return { ...this.rerankerStatus }; }

    subscribe(listener: (status: LocalAiStatus) => void): () => void {
        if (this.disposed) {
            listener(this.getStatus());
            return () => undefined;
        }
        this.listeners.add(listener);
        listener(this.getStatus());
        return () => this.listeners.delete(listener);
    }

    async prepare(allowDownload: boolean): Promise<void> {
        if (this.prepareTask) return await this.prepareTask;
        const task = this.prepareRole("embedding", allowDownload);
        this.prepareTask = task;
        try {
            await task;
        } finally {
            if (this.prepareTask === task) this.prepareTask = null;
        }
    }

    async prepareReranker(allowDownload: boolean): Promise<void> {
        if (this.rerankerPrepareTask) return await this.rerankerPrepareTask;
        const task = this.prepareRole("reranker", allowDownload);
        this.rerankerPrepareTask = task;
        try {
            await task;
        } finally {
            if (this.rerankerPrepareTask === task) this.rerankerPrepareTask = null;
        }
    }

    private async prepareRole(role: LocalAiRole, allowDownload: boolean): Promise<void> {
        this.assertActive();
        const current = this.getRoleStatus(role);
        if (current.phase === "ready" && this.activeRole === role) return;
        this.updateRole(role, { phase: allowDownload ? "downloading" : "loading", progress: 0, message: null });
        try {
            const assets = await this.runtimeAssets.prepare({
                allowDownload,
                onProgress: ({ loadedBytes, totalBytes }) => {
                    const runtimeProgress = totalBytes > 0 ? loadedBytes / totalBytes : 0;
                    this.updateRole(role, { progress: runtimeProgress * 0.1 });
                },
            });
            const policyId = getPolicyId(role);
            await this.scheduler.schedule(
                "foreground-query",
                () => this.request(
                    "prepare",
                    {
                        allowDownload,
                        runtime: {
                            policyId: assets.policyId,
                            wasmBinary: assets.wasmBinary,
                        },
                    },
                    undefined,
                    [assets.wasmBinary],
                    "interactive",
                    role,
                    policyId,
                ),
            );
            this.activeRole = role;
            const otherRole: LocalAiRole = role === "embedding" ? "reranker" : "embedding";
            if (this.getRoleStatus(otherRole).phase === "ready") this.updateRole(otherRole, { phase: "evicted" });
            this.updateRole(role, { phase: "ready", progress: 1, cached: true, message: null });
        } catch (error) {
            this.activeRole = null;
            const otherRole: LocalAiRole = role === "embedding" ? "reranker" : "embedding";
            if (this.getRoleStatus(otherRole).phase === "ready") this.updateRole(otherRole, { phase: "evicted" });
            this.updateRole(role, { phase: "error", progress: null, message: getErrorMessage(error) });
            throw error;
        }
    }

    async embed(request: LocalAiEmbeddingRequest): Promise<LocalAiEmbeddingResult> {
        this.assertActive();
        if (request.signal?.aborted) throw new DOMException("Embedding request aborted.", "AbortError");
        if (this.status.phase !== "ready" || this.activeRole !== "embedding") {
            try { await this.prepare(false); } catch {
                throw new EmbeddingError("not-ready", "builtin", "Built-in embedding is not prepared. Run the prepare command first.");
            }
        }
        const priority: LocalAiPriority = request.purpose === "query"
            ? "foreground-query"
            : request.purpose === "graph" ? "background-graph" : "explicit-vector";
        const span = this.trace?.begin("embedding.batch", {
            policyRef: createIndexTraceRef("policy", BUILTIN_EMBEDDING_POLICY.id),
            role: "embedding",
            counts: { total: request.texts.length, queued: request.texts.length },
        });
        try {
            const result = await this.scheduler.schedule(
                priority,
                () => this.request(
                    "embed",
                    { texts: [...request.texts], purpose: request.purpose },
                    request.signal,
                    [],
                    "interactive",
                    "embedding",
                    BUILTIN_EMBEDDING_POLICY.id,
                ),
                request.signal,
            );
            const decoded = decodeEmbeddingResult(result);
            span?.finish("completed", null, { total: request.texts.length, processed: decoded.vectors.length, queued: 0 });
            return decoded;
        } catch (error: unknown) {
            span?.finish(isAbortError(error) ? "cancelled" : "failed", getTraceErrorCode(error));
            throw error;
        }
    }

    async rerank(request: LocalAiRerankRequest): Promise<LocalAiRerankResult> {
        this.assertActive();
        if (request.signal?.aborted) throw new DOMException("Rerank request aborted.", "AbortError");
        if (request.candidates.length === 0) return { scores: [], latencyMs: 0, truncatedCandidateCount: 0 };
        if (this.rerankerStatus.phase !== "ready" || this.activeRole !== "reranker") {
            try { await this.prepareReranker(false); } catch {
                throw new Error("Built-in reranker is not prepared. Run the prepare action first.");
            }
        }
        const span = this.trace?.begin("rerank.batch", {
            policyRef: createIndexTraceRef("policy", BUILTIN_RERANK_POLICY.id),
            role: "reranker",
            counts: { total: request.candidates.length, queued: request.candidates.length },
        });
        try {
            const result = await this.scheduler.schedule(
                "foreground-query",
                () => this.request(
                    "rerank",
                    {
                        query: request.query,
                        candidates: request.candidates.map((candidate) => ({ ...candidate })),
                    },
                    request.signal,
                    [],
                    "interactive",
                    "reranker",
                    BUILTIN_RERANK_POLICY.id,
                ),
                request.signal,
            );
            const decoded = decodeRerankResult(result, request.candidates.map((candidate) => candidate.id));
            span?.finish("completed", null, { total: request.candidates.length, processed: decoded.scores.length, queued: 0 });
            return decoded;
        } catch (error: unknown) {
            span?.finish(isAbortError(error) ? "cancelled" : "failed", isAbortError(error) ? "aborted" : "rerank-failed");
            throw error;
        }
    }

    async clear(): Promise<void> {
        this.assertActive();
        this.update({ phase: "clearing", progress: null, message: null });
        try {
            await this.request("clear", {}, undefined, [], "interactive", "embedding", BUILTIN_EMBEDDING_POLICY.id);
            if (!this.rerankerStatus.cached) await this.runtimeAssets.clear();
            if (this.activeRole === "embedding") this.activeRole = null;
            this.update({ phase: "not-installed", progress: null, cached: false, message: null });
        } catch (error) {
            this.update({ phase: "error", progress: null, message: getErrorMessage(error) });
            throw error;
        }
    }

    async clearReranker(): Promise<void> {
        this.assertActive();
        this.updateRole("reranker", { phase: "clearing", progress: null, message: null });
        try {
            await this.request("clear", {}, undefined, [], "interactive", "reranker", BUILTIN_RERANK_POLICY.id);
            if (!this.status.cached) await this.runtimeAssets.clear();
            if (this.activeRole === "reranker") this.activeRole = null;
            this.updateRole("reranker", { phase: "not-installed", progress: null, cached: false, message: null });
        } catch (error) {
            this.updateRole("reranker", { phase: "error", progress: null, message: getErrorMessage(error) });
            throw error;
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.scheduler.dispose();
        this.terminateWorker();
        this.rejectPending(new Error("Local AI runtime disposed."));
        this.listeners.clear();
    }

    hardCancel(): void {
        if (this.disposed) return;
        const error = new DOMException("Local AI worker was force-stopped.", "AbortError");
        this.scheduler.cancelPending(error);
        this.terminateWorker();
        this.activeRole = null;
        this.rejectPending(error);
        this.update({ phase: "error", progress: null, message: "Local AI worker was force-stopped." });
        this.updateRole("reranker", { phase: "error", progress: null, message: "Local AI worker was force-stopped." });
    }

    private ensureWorker(): Worker {
        this.assertActive();
        if (this.worker) return this.worker;
        const handle = this.createWorker();
        this.workerEpoch += 1;
        this.workerUrl = handle.objectUrl;
        this.worker = handle.worker;
        this.worker.onmessage = (event: MessageEvent<unknown>) => this.onMessage(event.data);
        this.worker.onerror = (event: ErrorEvent) => {
            this.handleWorkerFailure(new Error(event.message || "Local AI worker failed."));
        };
        return this.worker;
    }

    private request(
        operation: LocalAiWorkerOperation,
        payload: Record<string, unknown>,
        signal?: AbortSignal,
        transfer: Transferable[] = [],
        jobId: string = "interactive",
        role: LocalAiRole = "embedding",
        policyId: string = BUILTIN_EMBEDDING_POLICY.id,
    ): Promise<unknown> {
        if (signal?.aborted) return Promise.reject(new DOMException("Embedding request aborted.", "AbortError"));
        const requestId = `local-ai-${++this.requestSequence}`;
        const worker = this.ensureWorker();
        const workerEpoch = this.workerEpoch;
        return new Promise((resolve, reject) => {
            const abort = () => {
                const pending = this.pending.get(requestId);
                if (!pending) return;
                this.pending.delete(requestId);
                pending.cleanup();
                this.postCancellation(worker, requestId, jobId, workerEpoch, pending.role, pending.policyId);
                reject(new DOMException("Embedding request aborted.", "AbortError"));
            };
            const timeoutId = globalThis.setTimeout(() => {
                const pending = this.pending.get(requestId);
                if (!pending) return;
                this.pending.delete(requestId);
                pending.cleanup();
                reject(new Error(`Local AI worker request timed out: ${operation}.`));
            }, operation === "prepare" ? 10 * 60_000 : 2 * 60_000);
            const cleanup = () => {
                globalThis.clearTimeout(timeoutId);
                signal?.removeEventListener("abort", abort);
            };
            this.pending.set(requestId, { jobId, workerEpoch, role, policyId, resolve, reject, cleanup });
            signal?.addEventListener("abort", abort, { once: true });
            const request: LocalAiWorkerRequest = {
                v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
                requestId,
                jobId,
                workerEpoch,
                role,
                policyId,
                operation,
                payload,
            };
            worker.postMessage(request, transfer);
        });
    }

    private onMessage(value: unknown): void {
        const message = parseLocalAiWorkerMessage(value);
        if (!message || message.workerEpoch !== this.workerEpoch) return;
        const pending = this.pending.get(message.requestId);
        if (!pending || pending.workerEpoch !== message.workerEpoch || pending.jobId !== message.jobId
            || pending.role !== message.role || pending.policyId !== message.policyId) return;
        if (message.type === "progress") {
            const modelProgress = message.progress;
            this.updateRole(message.role, { progress: modelProgress === null ? null : 0.1 + modelProgress * 0.9 });
            return;
        }
        this.pending.delete(message.requestId);
        pending.cleanup();
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error?.safeMessage || "Local AI request failed."));
    }

    private update(patch: Partial<LocalAiStatus>): void {
        this.updateRole("embedding", patch);
    }

    private updateRole(role: LocalAiRole, patch: Partial<LocalAiStatus>): void {
        if (role === "reranker") {
            this.rerankerStatus = { ...this.rerankerStatus, ...patch, role };
            return;
        }
        this.status = { ...this.status, ...patch, role };
        for (const listener of this.listeners) listener(this.getStatus());
    }

    private getRoleStatus(role: LocalAiRole): LocalAiStatus {
        return role === "embedding" ? this.status : this.rerankerStatus;
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.cleanup();
            pending.reject(error);
        }
        this.pending.clear();
    }

    private postCancellation(
        worker: Worker,
        targetRequestId: string,
        jobId: string,
        workerEpoch: number,
        role: LocalAiRole,
        policyId: string,
    ): void {
        const request: LocalAiWorkerRequest = {
            v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
            requestId: `local-ai-${++this.requestSequence}`,
            jobId,
            workerEpoch,
            role,
            policyId,
            operation: "cancel",
            payload: { targetRequestId },
        };
        worker.postMessage(request);
    }

    private handleWorkerFailure(error: Error): void {
        this.terminateWorker();
        this.activeRole = null;
        this.rejectPending(error);
        this.update({ phase: "error", progress: null, message: error.message });
    }

    private terminateWorker(): void {
        if (this.worker) {
            this.worker.onmessage = null;
            this.worker.onerror = null;
            this.worker.terminate();
        }
        this.worker = null;
        if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
        this.workerUrl = null;
    }

    private assertActive(): void {
        if (this.disposed) throw new Error("Local AI runtime disposed.");
    }
}

function createEmbeddedWorker(): LocalAiWorkerHandle {
    const objectUrl = URL.createObjectURL(new Blob([__VAULT_COACH_LOCAL_AI_WORKER_SOURCE__], { type: "text/javascript" }));
    return { worker: new Worker(objectUrl), objectUrl };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function getTraceErrorCode(error: unknown): string {
    if (isAbortError(error)) return "aborted";
    return error instanceof EmbeddingError ? error.code : "embedding-failed";
}

function decodeEmbeddingResult(value: unknown): LocalAiEmbeddingResult {
    if (typeof value !== "object" || value === null) throw new Error("Local AI worker returned an invalid embedding result.");
    const result = value as { count?: unknown; dimension?: unknown; buffer?: unknown; latencyMs?: unknown };
    if (!Number.isSafeInteger(result.count) || !Number.isSafeInteger(result.dimension)
        || (result.count as number) < 1 || (result.dimension as number) < 1
        || !(result.buffer instanceof ArrayBuffer)
        || result.buffer.byteLength !== (result.count as number) * (result.dimension as number) * Float32Array.BYTES_PER_ELEMENT
        || typeof result.latencyMs !== "number" || !Number.isFinite(result.latencyMs)) {
        throw new Error("Local AI worker returned a malformed embedding buffer.");
    }
    const count = result.count as number;
    const dimension = result.dimension as number;
    const values = new Float32Array(result.buffer);
    if (values.some((entry) => !Number.isFinite(entry))) throw new Error("Local AI worker returned non-finite embeddings.");
    const vectors: number[][] = [];
    for (let index = 0; index < count; index += 1) {
        vectors.push(Array.from(values.slice(index * dimension, (index + 1) * dimension)));
    }
    return { vectors, latencyMs: result.latencyMs };
}

function decodeRerankResult(value: unknown, expectedCandidateIds: readonly string[]): LocalAiRerankResult {
    if (typeof value !== "object" || value === null) throw new Error("Local AI worker returned an invalid rerank result.");
    const result = value as { scores?: unknown; latencyMs?: unknown; truncatedCandidateCount?: unknown };
    if (!Array.isArray(result.scores)
        || typeof result.latencyMs !== "number" || !Number.isFinite(result.latencyMs)
        || !Number.isSafeInteger(result.truncatedCandidateCount) || (result.truncatedCandidateCount as number) < 0) {
        throw new Error("Local AI worker returned malformed rerank diagnostics.");
    }
    const expectedIds = new Set(expectedCandidateIds);
    const seenIds = new Set<string>();
    const scores = result.scores.map((entry) => {
        if (typeof entry !== "object" || entry === null) throw new Error("Local AI worker returned a malformed rerank score.");
        const candidate = entry as { candidateId?: unknown; score?: unknown };
        if (typeof candidate.candidateId !== "string" || !expectedIds.has(candidate.candidateId)
            || seenIds.has(candidate.candidateId) || typeof candidate.score !== "number" || !Number.isFinite(candidate.score)) {
            throw new Error("Local AI worker returned an invalid or duplicate rerank score.");
        }
        seenIds.add(candidate.candidateId);
        return { candidateId: candidate.candidateId, score: candidate.score };
    });
    if (seenIds.size !== expectedIds.size) throw new Error("Local AI worker did not score every rerank candidate.");
    return {
        scores,
        latencyMs: result.latencyMs,
        truncatedCandidateCount: result.truncatedCandidateCount as number,
    };
}

function getPolicyId(role: LocalAiRole): string {
    return role === "embedding" ? BUILTIN_EMBEDDING_POLICY.id : BUILTIN_RERANK_POLICY.id;
}
