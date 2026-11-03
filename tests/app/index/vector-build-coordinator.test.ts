import { describe, expect, it, vi } from "vitest";
import { VectorBuildCoordinator } from "../../../src/app/index/vector-build-coordinator";
import type { VectorBuildJob } from "../../../src/domain/index-jobs/vector-build-job";

describe("VectorBuildCoordinator", () => {
    it("persists queued state before running and activates only for the current Core generation", async () => {
        const gate = createDeferred<void>();
        const saved: VectorBuildJob[] = [];
        let activeCore = "core-1";
        const coordinator = new VectorBuildCoordinator({
            runner: {
                rebuildVectorIndex: vi.fn(async (_signal, hooks) => {
                    await hooks?.onPhase?.("embedding");
                    await gate.promise;
                    hooks?.beforeActivate();
                    return { ready: true, vectorCount: 2, dimension: 384, lastBuiltAt: 1 };
                }),
            },
            store: createStore(saved),
            getActiveCoreGenerationId: () => activeCore,
            getEmbeddingPolicyId: () => "policy-1",
            onStateChanged: () => undefined,
            now: createClock(),
        });

        const queued = await coordinator.enqueue(activeCore);
        expect(queued.phase).toBe("queued");
        expect(saved[0]?.phase).toBe("queued");
        await waitFor(() => coordinator.getState()?.phase === "embedding");
        expect(coordinator.getState()?.phase).toBe("embedding");

        gate.resolve();
        const completed = await coordinator.waitFor(queued.jobId);
        expect(completed).toMatchObject({ phase: "rag-ready", vectorCount: 2 });
        expect(saved.map((job) => job.phase)).toEqual(expect.arrayContaining(["queued", "embedding", "rag-ready"]));
        coordinator.dispose();
    });

    it("marks a build stale when the Core identity changes before vector activation", async () => {
        const gate = createDeferred<void>();
        let activeCore = "core-1";
        const coordinator = new VectorBuildCoordinator({
            runner: {
                rebuildVectorIndex: async (_signal, hooks) => {
                    await gate.promise;
                    hooks?.beforeActivate();
                    return { ready: true, vectorCount: 2, dimension: 384, lastBuiltAt: 1 };
                },
            },
            store: createStore([]),
            getActiveCoreGenerationId: () => activeCore,
            getEmbeddingPolicyId: () => "policy-1",
            onStateChanged: () => undefined,
        });

        const queued = await coordinator.enqueue(activeCore);
        activeCore = "core-2";
        gate.resolve();

        await expect(coordinator.waitFor(queued.jobId)).resolves.toMatchObject({ phase: "stale", errorCode: "identity-changed" });
        coordinator.dispose();
    });

    it("settles a replaced vector job as superseded instead of returning the replacement state", async () => {
        let calls = 0;
        const coordinator = new VectorBuildCoordinator({
            runner: {
                rebuildVectorIndex: async (signal) => {
                    calls += 1;
                    if (calls === 1) await waitUntilAborted(signal);
                    return { ready: true, vectorCount: 2, dimension: 384, lastBuiltAt: 1 };
                },
            },
            store: createStore([]),
            getActiveCoreGenerationId: () => "core-1",
            getEmbeddingPolicyId: () => "policy-1",
            onStateChanged: () => undefined,
        });

        const first = await coordinator.enqueue("core-1");
        const firstCompletion = coordinator.waitFor(first.jobId);
        const replacement = await coordinator.enqueue("core-1");

        await expect(firstCompletion).resolves.toMatchObject({
            jobId: first.jobId,
            phase: "superseded",
            errorCode: "new-core-generation",
        });
        await expect(coordinator.waitFor(replacement.jobId)).resolves.toMatchObject({
            jobId: replacement.jobId,
            phase: "rag-ready",
        });
        coordinator.dispose();
    });

    it("keeps a shutdown-suspended job nonterminal so restart can requeue it", async () => {
        const saved: VectorBuildJob[] = [];
        const coordinator = new VectorBuildCoordinator({
            runner: {
                rebuildVectorIndex: async (signal) => {
                    await waitUntilAborted(signal);
                    return { ready: true, vectorCount: 2, dimension: 384, lastBuiltAt: 1 };
                },
            },
            store: createStore(saved),
            getActiveCoreGenerationId: () => "core-1",
            getEmbeddingPolicyId: () => "policy-1",
            onStateChanged: () => undefined,
        });

        const queued = await coordinator.enqueue("core-1");
        const completion = coordinator.waitFor(queued.jobId);
        await waitFor(() => coordinator.getState()?.phase === "preparing-model");
        coordinator.suspend();

        await expect(completion).resolves.toMatchObject({ jobId: queued.jobId, phase: "preparing-model" });
        expect(saved.at(-1)?.phase).toBe("preparing-model");
        expect(saved.at(-1)?.errorCode).toBeNull();
        coordinator.dispose();
    });
});

function createStore(saved: VectorBuildJob[]) {
    let current: VectorBuildJob | null = null;
    return {
        load: async () => current ? { ...current } : null,
        save: async (job: VectorBuildJob) => { current = { ...job }; saved.push({ ...job }); },
        clear: async () => { current = null; },
    };
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve: (value?: T) => resolve(value as T) };
}

function createClock(): () => number {
    let value = 100;
    return () => ++value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error("Timed out waiting for coordinator state.");
}

async function waitUntilAborted(signal: AbortSignal | undefined): Promise<void> {
    if (!signal) throw new Error("Expected an abort signal.");
    if (signal.aborted) signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(
            signal.reason instanceof Error ? signal.reason : new DOMException("Aborted.", "AbortError"),
        ), { once: true });
    });
}
