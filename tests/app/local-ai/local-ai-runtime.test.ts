import { describe, expect, it, vi } from "vitest";
import { LocalAIRuntime, type LocalAiWorkerFactory } from "../../../src/app/local-ai/local-ai-runtime";
import type {
    PrepareRuntimeAssetsOptions,
    RuntimeAssetStore,
} from "../../../src/domain/local-ai/local-ai-runtime-assets";

interface WorkerRequest {
    id: string;
    type: string;
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
            if (request.type === "prepare") {
                this.emit({ type: "progress", progress: 0.5 });
                this.respond(request.id, { ready: true });
            } else if (request.type === "embed") {
                this.respond(request.id, { vectors: [[1, 0]], latencyMs: 8 });
            } else {
                this.respond(request.id, { ok: true });
            }
        });
    }

    terminate(): void { this.terminated = true; }

    private respond(id: string, result: unknown): void {
        this.emit({ type: "response", id, ok: true, result });
    }

    private emit(data: unknown): void {
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
        expect(worker.requests.map((request) => request.type)).toEqual(["prepare", "embed", "clear"]);
        const prepareRuntime = worker.requests[0]?.payload.runtime as { wasmBinary?: ArrayBuffer };
        expect(worker.transfers[0]).toEqual([prepareRuntime.wasmBinary]);
        expect(assets.prepareCalls).toHaveLength(1);
        expect(assets.clearCalls).toBe(1);
        expect(worker.terminated).toBe(true);
    });

    it("rejects an aborted embedding request without posting it to the worker", async () => {
        const { runtime, worker } = createHarness();
        await runtime.prepare(true);
        const controller = new AbortController();
        controller.abort();

        await expect(runtime.embed({ texts: ["query"], purpose: "query", signal: controller.signal }))
            .rejects.toMatchObject({ name: "AbortError" });
        expect(worker.requests.map((request) => request.type)).toEqual(["prepare"]);
        await runtime.dispose();
    });

    it("coalesces concurrent prepare calls into one runtime and worker operation", async () => {
        const { runtime, worker, assets } = createHarness();

        await Promise.all([runtime.prepare(true), runtime.prepare(true)]);

        expect(assets.prepareCalls).toHaveLength(1);
        expect(worker.requests.filter((request) => request.type === "prepare")).toHaveLength(1);
        await runtime.dispose();
    });

    it("moves to error when preparation fails", async () => {
        const worker = new FakeLocalAiWorker();
        worker.postMessage = vi.fn((value: unknown) => {
            const request = value as WorkerRequest;
            queueMicrotask(() => worker.onmessage?.({
                data: { type: "response", id: request.id, ok: false, error: { message: "download failed" } },
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
});
