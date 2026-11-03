import { describe, expect, it, vi } from "vitest";
import { LocalAIRuntime, type LocalAiWorkerFactory } from "../../../src/app/local-ai/local-ai-runtime";
import type {
    PrepareRuntimeAssetsOptions,
    RuntimeAssetStore,
} from "../../../src/domain/local-ai/local-ai-runtime-assets";
import { LOCAL_AI_WORKER_PROTOCOL_VERSION } from "../../../src/infrastructure/local-ai/local-ai-worker-protocol";
import { IndexLifecycleTrace } from "../../../src/app/observability/index-lifecycle-trace";

interface WorkerRequest {
    requestId: string;
    jobId: string;
    workerEpoch: number;
    policyId: string;
    operation: string;
    payload: Record<string, unknown>;
}

class FakeLocalAiWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly requests: WorkerRequest[] = [];
    readonly transfers: Transferable[][] = [];
    terminated = false;

    postMessage(value: unknown, transfer: Transferable[] = []): void {
        const request = value as WorkerRequest;
        this.requests.push(request);
        this.transfers.push(transfer);
        queueMicrotask(() => {
            if (request.operation === "prepare") {
                this.emitMessage(request, { type: "progress", progress: 0.5 });
                this.respond(request, { ready: true });
            } else if (request.operation === "embed") {
                this.respond(request, { count: 1, dimension: 2, buffer: new Float32Array([1, 0]).buffer, latencyMs: 8 });
            } else {
                this.respond(request, { ok: true });
            }
        });
    }

    terminate(): void { this.terminated = true; }

    private respond(request: WorkerRequest, result: unknown): void {
        this.emitMessage(request, { type: "response", ok: true, result });
    }

    private emitMessage(request: WorkerRequest, message: Record<string, unknown>): void {
        this.emit({
            v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            jobId: request.jobId,
            workerEpoch: request.workerEpoch,
            role: "embedding",
            policyId: request.policyId,
            ...message,
        });
    }

    emit(data: unknown): void {
        this.onmessage?.({ data } as MessageEvent<unknown>);
    }
}

class FakeRuntimeAssetStore implements RuntimeAssetStore {
    prepareCalls: PrepareRuntimeAssetsOptions[] = [];
    clearCalls = 0;

    async prepare(options: PrepareRuntimeAssetsOptions) {
        this.prepareCalls.push(options);
        options.onProgress?.({ artifact: "runtime-wasm", loadedBytes: 4, totalBytes: 4 });
        return {
            policyId: "test-runtime",
            wasmBinary: new ArrayBuffer(4),
            source: "cache" as const,
        };
    }

    async clear(): Promise<void> { this.clearCalls += 1; }
}

function createHarness(): { runtime: LocalAIRuntime; worker: FakeLocalAiWorker; assets: FakeRuntimeAssetStore } {
    const worker = new FakeLocalAiWorker();
    const assets = new FakeRuntimeAssetStore();
    const factory: LocalAiWorkerFactory = () => ({ worker: worker as unknown as Worker, objectUrl: null });
    return { runtime: new LocalAIRuntime(assets, factory), worker, assets };
}

describe("LocalAIRuntime", () => {
    it("owns one worker and publishes prepare, embed, clear lifecycle states", async () => {
        const { runtime, worker, assets } = createHarness();
        const phases: string[] = [];
        const unsubscribe = runtime.subscribe((status) => phases.push(status.phase));

        await runtime.prepare(true);
        const result = await runtime.embed({ texts: ["query"], purpose: "query" });
        await runtime.clear();
        await runtime.dispose();
        unsubscribe();

        expect(result).toEqual({ vectors: [[1, 0]], latencyMs: 8 });
        expect(phases).toEqual(expect.arrayContaining(["not-installed", "downloading", "ready", "clearing"]));
        expect(worker.requests.map((request) => request.operation)).toEqual(["prepare", "embed", "clear"]);
        const prepareRuntime = worker.requests[0]?.payload.runtime as { wasmBinary?: ArrayBuffer };
        expect(worker.transfers[0]).toEqual([prepareRuntime.wasmBinary]);
        expect(assets.prepareCalls).toHaveLength(1);
        expect(assets.clearCalls).toBe(1);
        expect(worker.terminated).toBe(true);
    });

    it("records an embedding batch without request text or raw policy identity", async () => {
        const worker = new FakeLocalAiWorker();
        const trace = new IndexLifecycleTrace(10, createClock());
        const runtime = new LocalAIRuntime(
            new FakeRuntimeAssetStore(),
            () => ({ worker: worker as unknown as Worker, objectUrl: null }),
            trace,
        );
        await runtime.prepare(true);

        await runtime.embed({ texts: ["private query"], purpose: "query" });

        const events = trace.getEvents();
        expect(events).toEqual([
            expect.objectContaining({ operation: "embedding.batch", status: "started", counts: { total: 1, queued: 1 } }),
            expect.objectContaining({ operation: "embedding.batch", status: "completed", counts: { total: 1, processed: 1, queued: 0 } }),
        ]);
        expect(JSON.stringify(events)).not.toContain("private query");
        await runtime.dispose();
    });

    it("rejects an aborted embedding request without posting it to the worker", async () => {
        const { runtime, worker } = createHarness();
        await runtime.prepare(true);
        const controller = new AbortController();
        controller.abort();

        await expect(runtime.embed({ texts: ["query"], purpose: "query", signal: controller.signal }))
            .rejects.toMatchObject({ name: "AbortError" });
        expect(worker.requests.map((request) => request.operation)).toEqual(["prepare"]);
        await runtime.dispose();
    });

    it("coalesces concurrent prepare calls into one runtime and worker operation", async () => {
        const { runtime, worker, assets } = createHarness();

        await Promise.all([runtime.prepare(true), runtime.prepare(true)]);

        expect(assets.prepareCalls).toHaveLength(1);
        expect(worker.requests.filter((request) => request.operation === "prepare")).toHaveLength(1);
        await runtime.dispose();
    });

    it("moves to error when preparation fails", async () => {
        const worker = new FakeLocalAiWorker();
        worker.postMessage = vi.fn((value: unknown) => {
            const request = value as WorkerRequest;
            queueMicrotask(() => worker.onmessage?.({
                data: {
                    v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
                    type: "response",
                    requestId: request.requestId,
                    jobId: request.jobId,
                    workerEpoch: request.workerEpoch,
                    role: "embedding",
                    policyId: request.policyId,
                    ok: false,
                    error: { code: "download-failed", recoverable: true, safeMessage: "download failed" },
                },
            } as MessageEvent<unknown>));
        });
        const runtime = new LocalAIRuntime(
            new FakeRuntimeAssetStore(),
            () => ({ worker: worker as unknown as Worker, objectUrl: null }),
        );

        await expect(runtime.prepare(true)).rejects.toThrow("download failed");
        expect(runtime.getStatus()).toMatchObject({ phase: "error", message: "download failed" });
        await runtime.dispose();
    });

    it("ignores a response from a stale worker epoch", async () => {
        const worker = new FakeLocalAiWorker();
        worker.postMessage = vi.fn((value: unknown) => { worker.requests.push(value as WorkerRequest); });
        const runtime = new LocalAIRuntime(
            new FakeRuntimeAssetStore(),
            () => ({ worker: worker as unknown as Worker, objectUrl: null }),
        );
        let settled = false;
        const preparing = runtime.prepare(true).then(() => { settled = true; });
        await waitFor(() => worker.requests.length === 1);
        const request = worker.requests[0]!;

        worker.emit(createResponse(request, { ready: true }, request.workerEpoch + 1));
        await Promise.resolve();
        expect(settled).toBe(false);

        worker.emit(createResponse(request, { ready: true }));
        await preparing;
        expect(settled).toBe(true);
        await runtime.dispose();
    });

    it("rejects every pending request when the worker crashes", async () => {
        const worker = new FakeLocalAiWorker();
        worker.postMessage = vi.fn((value: unknown) => { worker.requests.push(value as WorkerRequest); });
        const runtime = new LocalAIRuntime(
            new FakeRuntimeAssetStore(),
            () => ({ worker: worker as unknown as Worker, objectUrl: null }),
        );
        const preparing = runtime.prepare(true);
        await waitFor(() => worker.requests.length === 1);

        worker.onerror?.({ message: "worker crashed" } as ErrorEvent);

        await expect(preparing).rejects.toThrow("worker crashed");
        expect(runtime.getStatus()).toMatchObject({ phase: "error", message: "worker crashed" });
        expect(worker.terminated).toBe(true);
        await runtime.dispose();
    });

    it("hard-cancels active and queued work, terminates the worker, and lazily recreates it", async () => {
        const firstWorker = new FakeLocalAiWorker();
        firstWorker.postMessage = (value: unknown, transfer: Transferable[] = []) => {
            const request = value as WorkerRequest;
            firstWorker.requests.push(request);
            firstWorker.transfers.push(transfer);
            if (request.operation === "prepare") {
                queueMicrotask(() => firstWorker.emit(createResponse(request, { ready: true })));
            }
        };
        const secondWorker = new FakeLocalAiWorker();
        const workers = [firstWorker, secondWorker];
        const runtime = new LocalAIRuntime(
            new FakeRuntimeAssetStore(),
            () => {
                const worker = workers.shift();
                if (!worker) throw new Error("Unexpected worker recreation.");
                return { worker: worker as unknown as Worker, objectUrl: null };
            },
        );
        await runtime.prepare(true);
        const active = runtime.embed({ texts: ["active"], purpose: "document" });
        const queued = runtime.embed({ texts: ["queued"], purpose: "graph" });
        const outcomes = Promise.allSettled([active, queued]);
        await waitFor(() => firstWorker.requests.some((request) => request.operation === "embed"));

        runtime.hardCancel();

        const [activeResult, queuedResult] = await outcomes;
        expect(activeResult).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
        expect(queuedResult).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
        expect(firstWorker.terminated).toBe(true);
        expect(runtime.getStatus()).toMatchObject({ phase: "error", cached: true });

        await runtime.prepare(false);
        expect(runtime.getStatus().phase).toBe("ready");
        expect(secondWorker.requests.map((request) => request.operation)).toEqual(["prepare"]);
        await runtime.dispose();
        await runtime.dispose();
        expect(secondWorker.terminated).toBe(true);
        await expect(runtime.prepare(false)).rejects.toThrow("disposed");
    });
});

function createResponse(request: WorkerRequest, result: unknown, workerEpoch: number = request.workerEpoch): unknown {
    return {
        v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
        type: "response",
        requestId: request.requestId,
        jobId: request.jobId,
        workerEpoch,
        role: "embedding",
        policyId: request.policyId,
        ok: true,
        result,
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error("Timed out waiting for worker request.");
}

function createClock(): () => number {
    let value = 0;
    return () => ++value;
}
