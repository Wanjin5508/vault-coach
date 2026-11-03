import { describe, expect, it } from "vitest";
import { SetupService, type SetupRuntimeSnapshot } from "../../../src/app/setup/setup-service";
import { createInitialSetupState, type PersistedSetupStateV1 } from "../../../src/app/setup/setup-state";

describe("SetupService", () => {
    it("resumes preparation and indexing from realtime runtime facts", async () => {
        const store = new MemorySetupStore(createInitialSetupState("new-install"));
        const runtime = runtimeSnapshot();
        const service = new SetupService({ store, getRuntimeSnapshot: () => runtime, now: createClock() });

        expect(service.getState()).toMatchObject({ step: "scope", shouldAutoOpen: true });
        await service.confirmScope();
        await service.startBuiltinPreparation();
        expect(service.getState().step).toBe("preparing");

        runtime.localAiPhase = "ready";
        await service.reconcileRuntime();
        expect(store.get().lastStep).toBe("ready-to-index");
        await service.startIndexing();
        runtime.coreReady = true;
        runtime.graphJobPhase = "structural";
        await service.reconcileRuntime();

        expect(service.getState()).toMatchObject({
            step: "searchable",
            coreReady: true,
            graphJobPhase: "structural",
        });
        await service.markSearchVerified(2);
        await service.complete();
        expect(store.get()).toMatchObject({ disposition: "completed", lastStep: "complete" });
    });

    it("does not advertise or prepare an unverified built-in model", async () => {
        const store = new MemorySetupStore(createInitialSetupState("new-install"));
        const runtime = runtimeSnapshot({ builtinEmbeddingGate: "unverified" });
        const service = new SetupService({ store, getRuntimeSnapshot: () => runtime });
        await service.confirmScope();

        expect(service.getState().capabilities).toEqual({
            embedding: "blocked-unverified",
            reranker: "not-delivered",
            utility: "not-delivered",
            graphRag: "not-delivered",
        });
        await expect(service.startBuiltinPreparation()).rejects.toThrow("not verified");
        await service.continueWithoutBuiltinEmbedding();
        expect(service.getState().step).toBe("ready-to-index");
    });

    it("keeps upgraded users out of forced onboarding but permits an explicit restart", async () => {
        const store = new MemorySetupStore(createInitialSetupState("current"));
        const service = new SetupService({ store, getRuntimeSnapshot: () => runtimeSnapshot() });

        expect(service.getState()).toMatchObject({ step: "complete", shouldAutoOpen: false });
        await service.reopen();
        expect(service.getState()).toMatchObject({
            step: "scope",
            shouldAutoOpen: false,
            persisted: { disposition: "pending", entryReason: "manual" },
        });
    });

    it("requires committed searchable sources before recording first success", async () => {
        const store = new MemorySetupStore({
            ...createInitialSetupState("new-install"),
            lastStep: "searchable",
        });
        const runtime = runtimeSnapshot();
        const service = new SetupService({ store, getRuntimeSnapshot: () => runtime });

        await expect(service.markSearchVerified(1)).rejects.toThrow("committed Core");
        runtime.coreReady = true;
        await expect(service.markSearchVerified(0)).rejects.toThrow("at least one source");
        await expect(service.markSearchVerified(1)).resolves.toMatchObject({ step: "optional-main-llm" });
    });
});

class MemorySetupStore {
    constructor(private state: PersistedSetupStateV1) {}
    get(): PersistedSetupStateV1 { return { ...this.state }; }
    async save(state: PersistedSetupStateV1): Promise<void> { this.state = { ...state }; }
}

function runtimeSnapshot(overrides: Partial<SetupRuntimeSnapshot> = {}): SetupRuntimeSnapshot {
    return {
        builtinEmbeddingGate: "verified",
        localAiPhase: "not-installed",
        coreReady: false,
        coreBusy: false,
        vectorJobPhase: null,
        graphJobPhase: null,
        mainLlmConfigured: false,
        ...overrides,
    };
}

function createClock(): () => number {
    let value = 100;
    return () => ++value;
}
