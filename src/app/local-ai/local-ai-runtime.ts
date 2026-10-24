import { EmbeddingError } from "../../domain/embedding/embedding-error";
import type {
    LocalAiEmbeddingRequest,
    LocalAiEmbeddingResult,
    LocalAiStatus,
    LocalAIRuntimePort,
} from "../../domain/local-ai/local-ai-types";

declare const __VAULT_COACH_LOCAL_AI_WORKER_SOURCE__: string;

interface PendingRequest {
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
export class LocalAIRuntime implements LocalAIRuntimePort {
    private worker: Worker | null = null;
    private workerUrl: string | null = null;
    private requestSequence = 0;
    private readonly pending = new Map<string, PendingRequest>();
    private readonly listeners = new Set<(status: LocalAiStatus) => void>();
    private status: LocalAiStatus = {
        role: "embedding", phase: "not-installed", progress: null, message: null, cached: false, backend: "wasm",
    };

    constructor(private readonly createWorker: LocalAiWorkerFactory = createEmbeddedWorker) {}

    getStatus(): LocalAiStatus { return { ...this.status }; }

    subscribe(listener: (status: LocalAiStatus) => void): () => void {
        this.listeners.add(listener);
        listener(this.getStatus());
        return () => this.listeners.delete(listener);
    }

    async prepare(allowDownload: boolean): Promise<void> {
        if (this.status.phase === "ready") return;
        this.update({ phase: allowDownload ? "downloading" : "loading", progress: 0, message: null });
        try {
            await this.request("prepare", { allowDownload });
            this.update({ phase: "ready", progress: 1, cached: true, message: null });
        } catch (error) {
            this.update({ phase: "error", progress: null, message: getErrorMessage(error) });
            throw error;
        }
    }

    async embed(request: LocalAiEmbeddingRequest): Promise<LocalAiEmbeddingResult> {
        if (request.signal?.aborted) throw new DOMException("Embedding request aborted.", "AbortError");
        if (this.status.phase !== "ready") {
            try { await this.prepare(false); } catch {
                throw new EmbeddingError("not-ready", "builtin", "Built-in embedding is not prepared. Run the prepare command first.");
            }
        }
        return await this.request(
            "embed",
            { texts: [...request.texts], purpose: request.purpose },
            request.signal,
        ) as LocalAiEmbeddingResult;
    }

    async clear(): Promise<void> {
        this.update({ phase: "clearing", progress: null, message: null });
        try {
            await this.request("clear", {});
            this.update({ phase: "not-installed", progress: null, cached: false, message: null });
        } catch (error) {
            this.update({ phase: "error", progress: null, message: getErrorMessage(error) });
            throw error;
        }
    }

    async dispose(): Promise<void> {
        if (this.worker) {
            this.worker.terminate();
        }
        this.rejectPending(new Error("Local AI runtime disposed."));
        this.worker = null;
        if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
        this.workerUrl = null;
    }

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        const handle = this.createWorker();
        this.workerUrl = handle.objectUrl;
        this.worker = handle.worker;
        this.worker.onmessage = (event: MessageEvent<unknown>) => this.onMessage(event.data);
        this.worker.onerror = (event: ErrorEvent) => {
            const error = new Error(event.message || "Local AI worker failed.");
            this.rejectPending(error);
            this.update({ phase: "error", progress: null, message: error.message });
        };
        return this.worker;
    }

    private request(type: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
        if (signal?.aborted) return Promise.reject(new DOMException("Embedding request aborted.", "AbortError"));
        const id = `local-ai-${++this.requestSequence}`;
        const worker = this.ensureWorker();
        return new Promise((resolve, reject) => {
            const abort = () => {
                const pending = this.pending.get(id);
                if (!pending) return;
                this.pending.delete(id);
                pending.cleanup();
                reject(new DOMException("Embedding request aborted.", "AbortError"));
            };
            const cleanup = () => signal?.removeEventListener("abort", abort);
            this.pending.set(id, { resolve, reject, cleanup });
            signal?.addEventListener("abort", abort, { once: true });
            worker.postMessage({ id, type, payload });
        });
    }

    private onMessage(value: unknown): void {
        if (!isWorkerMessage(value)) return;
        const message = value;
        if (message.type === "progress") {
            this.update({ progress: typeof message.progress === "number" ? message.progress : null });
            return;
        }
        if (message.type === "fatal") {
            const error = new Error(message.error?.message || "Local AI worker failed.");
            this.rejectPending(error);
            this.update({ phase: "error", progress: null, message: error.message });
            return;
        }
        if (message.type !== "response" || !message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error?.message || "Local AI request failed."));
    }

    private update(patch: Partial<LocalAiStatus>): void {
        this.status = { ...this.status, ...patch };
        for (const listener of this.listeners) listener(this.getStatus());
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.cleanup();
            pending.reject(error);
        }
        this.pending.clear();
    }
}

function createEmbeddedWorker(): LocalAiWorkerHandle {
    const objectUrl = URL.createObjectURL(new Blob([__VAULT_COACH_LOCAL_AI_WORKER_SOURCE__], { type: "text/javascript" }));
    return { worker: new Worker(objectUrl), objectUrl };
}

interface WorkerMessage {
    type?: string;
    id?: string;
    ok?: boolean;
    result?: unknown;
    error?: { message?: string };
    progress?: number;
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
    return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}
