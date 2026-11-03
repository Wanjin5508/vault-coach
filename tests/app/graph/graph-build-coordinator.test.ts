import { describe, expect, it } from "vitest";
import { GraphBuildCoordinator } from "../../../src/app/graph/graph-build-coordinator";
import type { GraphBuildJob } from "../../../src/domain/graph-jobs/graph-build-job";
import type { GraphSnapshotV1 } from "../../../src/domain/graph/graph-types";

describe("GraphBuildCoordinator", () => {
    it("rejects a staged graph when the active Core changes before activation", async () => {
        const gate = createDeferred<void>();
        let activeCore = "core-1";
        const coordinator = new GraphBuildCoordinator({
            structural: {
                rebuildAll: async (_signal, hooks) => {
                    await hooks?.onPhase?.("snapshotting");
                    await hooks?.onPhase?.("structural");
                    await gate.promise;
                    await hooks?.onPhase?.("validating");
                    hooks?.beforeActivate();
                    return emptySnapshot();
                },
                syncChangedFiles: async () => emptySnapshot(),
            },
            semantic: createSemanticRunner(),
            store: createStore([]),
            getActiveCoreGenerationId: () => activeCore,
            getGraphPolicyId: () => "graph-policy-1",
            onStateChanged: () => undefined,
        });

        const queued = await coordinator.enqueueFull(activeCore, false);
        await waitFor(() => coordinator.getState()?.phase === "structural");
        activeCore = "core-2";
        gate.resolve();

        await expect(coordinator.waitFor(queued.jobId)).resolves.toMatchObject({
            phase: "stale",
            errorCode: "identity-changed",
        });
        coordinator.dispose();
    });

    it("persists semantic checkpoint progress before marking an incremental graph ready", async () => {
        const saved: GraphBuildJob[] = [];
        const coordinator = new GraphBuildCoordinator({
            structural: {
                rebuildAll: async () => emptySnapshot(),
                syncChangedFiles: async (_sync, _renames, _signal, hooks) => {
                    await hooks?.onPhase?.("snapshotting");
                    await hooks?.onPhase?.("structural");
                    await hooks?.onPhase?.("validating");
                    hooks?.beforeActivate();
                    return emptySnapshot();
                },
            },
            semantic: {
                reconcileWithCurrentSources: async () => undefined,
                syncChangedFiles: async (_sync, _signal, hooks) => {
                    await hooks?.onPhase?.("extracting");
                    await hooks?.onCheckpoint?.({ totalSections: 5, processedSections: 2, failedSections: 1, queuedSections: 2 });
                    await hooks?.onPhase?.("concept-embedding");
                    await hooks?.onPhase?.("candidate-building");
                    await hooks?.onPhase?.("validating");
                },
            },
            store: createStore(saved),
            getActiveCoreGenerationId: () => "core-1",
            getGraphPolicyId: () => "graph-policy-1",
            onStateChanged: () => undefined,
            now: createClock(),
        });

        const queued = await coordinator.enqueueIncremental(
            "core-1",
            { affectedFiles: ["b.md", "a.md", "a.md"] },
            [{ oldPath: "old.md", newPath: "new.md" }],
        );
        const completed = await coordinator.waitFor(queued.jobId);

        expect(completed).toMatchObject({
            phase: "graph-ready",
            affectedFiles: ["a.md", "b.md"],
            checkpoint: { processedSections: 2, failedSections: 1, queuedSections: 2 },
        });
        expect(saved.map((job) => job.phase)).toEqual(expect.arrayContaining([
            "queued", "snapshotting", "structural", "extracting", "concept-embedding", "candidate-building", "graph-ready",
        ]));
        coordinator.dispose();
    });

    it("requeues a persisted nonterminal job after restart with the same durable inputs", async () => {
        const restored = graphJob({
            jobId: "graph-job-before-restart",
            phase: "candidate-building",
            affectedFiles: ["notes/a.md", "notes/b.md"],
            renames: [{ oldPath: "notes/old.md", newPath: "notes/new.md" }],
            checkpoint: { processedSections: 4, failedSections: 1, queuedSections: 2 },
        });
        let receivedFiles: string[] = [];
        let receivedRenames: GraphBuildJob["renames"] = [];
        const coordinator = new GraphBuildCoordinator({
            structural: {
                rebuildAll: async () => emptySnapshot(),
                syncChangedFiles: async (sync, renames, _signal, hooks) => {
                    receivedFiles = [...sync.affectedFiles];
                    receivedRenames = [...(renames ?? [])];
                    await hooks?.onPhase?.("snapshotting");
                    await hooks?.onPhase?.("structural");
                    await hooks?.onPhase?.("validating");
                    hooks?.beforeActivate();
                    return emptySnapshot();
                },
            },
            semantic: createSemanticRunner(),
            store: createStore([], restored),
            getActiveCoreGenerationId: () => "core-1",
            getGraphPolicyId: () => "graph-policy-1",
            onStateChanged: () => undefined,
            now: createClock(),
        });

        const requeued = await coordinator.restore();
        if (!requeued) throw new Error("Expected a restored graph job.");
        const completed = await coordinator.waitFor(requeued.jobId);

        expect(requeued).toMatchObject({ mode: "incremental", phase: "queued" });
        expect(requeued.jobId).not.toBe(restored.jobId);
        expect(receivedFiles).toEqual(restored.affectedFiles);
        expect(receivedRenames).toEqual(restored.renames);
        expect(completed.phase).toBe("graph-ready");
        coordinator.dispose();
    });

    it("cancels the active graph job without changing its generation identity", async () => {
        const coordinator = new GraphBuildCoordinator({
            structural: {
                rebuildAll: async (signal) => { await waitUntilAborted(signal); return emptySnapshot(); },
                syncChangedFiles: async () => emptySnapshot(),
            },
            semantic: createSemanticRunner(),
            store: createStore([]),
            getActiveCoreGenerationId: () => "core-1",
            getGraphPolicyId: () => "graph-policy-1",
            onStateChanged: () => undefined,
        });

        const queued = await coordinator.enqueueFull("core-1", false);
        const completion = coordinator.waitFor(queued.jobId);
        coordinator.cancel();

        await expect(completion).resolves.toMatchObject({
            jobId: queued.jobId,
            sourceCoreGenerationId: "core-1",
            phase: "cancelled",
            errorCode: "aborted",
        });
        coordinator.dispose();
    });

    it("settles the replaced job as superseded instead of returning the replacement state", async () => {
        let calls = 0;
        const coordinator = new GraphBuildCoordinator({
            structural: {
                rebuildAll: async (signal) => {
                    calls += 1;
                    if (calls === 1) await waitUntilAborted(signal);
                    return emptySnapshot();
                },
                syncChangedFiles: async () => emptySnapshot(),
            },
            semantic: createSemanticRunner(),
            store: createStore([]),
            getActiveCoreGenerationId: () => "core-1",
            getGraphPolicyId: () => "graph-policy-1",
            onStateChanged: () => undefined,
        });

        const first = await coordinator.enqueueFull("core-1", false);
        const firstCompletion = coordinator.waitFor(first.jobId);
        const replacement = await coordinator.enqueueFull("core-1", false);

        await expect(firstCompletion).resolves.toMatchObject({
            jobId: first.jobId,
            phase: "superseded",
            errorCode: "new-core-generation",
        });
        await expect(coordinator.waitFor(replacement.jobId)).resolves.toMatchObject({
            jobId: replacement.jobId,
            phase: "graph-ready",
        });
        coordinator.dispose();
    });

    it("keeps a shutdown-suspended graph job nonterminal so restart can requeue it", async () => {
        const saved: GraphBuildJob[] = [];
        const coordinator = new GraphBuildCoordinator({
            structural: {
                rebuildAll: async (signal, hooks) => {
                    await hooks?.onPhase?.("snapshotting");
                    await hooks?.onPhase?.("structural");
                    await waitUntilAborted(signal);
                    return emptySnapshot();
                },
                syncChangedFiles: async () => emptySnapshot(),
            },
            semantic: createSemanticRunner(),
            store: createStore(saved),
            getActiveCoreGenerationId: () => "core-1",
            getGraphPolicyId: () => "graph-policy-1",
            onStateChanged: () => undefined,
        });

        const queued = await coordinator.enqueueFull("core-1", false);
        const completion = coordinator.waitFor(queued.jobId);
        await waitFor(() => coordinator.getState()?.phase === "structural");
        coordinator.suspend();

        await expect(completion).resolves.toMatchObject({ jobId: queued.jobId, phase: "structural" });
        expect(saved.at(-1)?.phase).toBe("structural");
        expect(saved.at(-1)?.errorCode).toBeNull();
        coordinator.dispose();
    });
});

function createSemanticRunner() {
    return {
        syncChangedFiles: async () => undefined,
        reconcileWithCurrentSources: async () => undefined,
    };
}

function createStore(saved: GraphBuildJob[], initial: GraphBuildJob | null = null) {
    let current: GraphBuildJob | null = initial;
    return {
        load: async () => current ? cloneJob(current) : null,
        save: async (job: GraphBuildJob) => { current = cloneJob(job); saved.push(cloneJob(job)); },
        clear: async () => { current = null; },
    };
}

function graphJob(overrides: Partial<GraphBuildJob> = {}): GraphBuildJob {
    return {
        schemaVersion: 1,
        jobId: "graph-job-1",
        sourceCoreGenerationId: "core-1",
        graphPolicyId: "graph-policy-1",
        mode: "incremental",
        phase: "queued",
        affectedFiles: [],
        renames: [],
        reconcileSemanticSources: false,
        checkpoint: { processedSections: 0, failedSections: 0, queuedSections: 0 },
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        ...overrides,
    };
}

function cloneJob(job: GraphBuildJob): GraphBuildJob {
    return { ...job, affectedFiles: [...job.affectedFiles], renames: job.renames.map((rename) => ({ ...rename })), checkpoint: { ...job.checkpoint } };
}

function emptySnapshot(): GraphSnapshotV1 {
    return { schemaVersion: 1, nodes: [], edges: [], stats: { documentCount: 0, sectionCount: 0, tagCount: 0, edgeCount: 0 } };
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error("Timed out waiting for graph job state.");
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
