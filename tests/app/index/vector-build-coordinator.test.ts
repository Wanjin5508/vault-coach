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
