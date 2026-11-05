import type { GraphBuildJobPhase } from "../../domain/graph-jobs/graph-build-job";
import type { VectorBuildJobPhase } from "../../domain/index-jobs/vector-build-job";
import type { LocalAiPhase } from "../../domain/local-ai/local-ai-types";
import {
    SETUP_STATE_SCHEMA_VERSION,
    cloneSetupState,
    type PersistedSetupStateV1,
    type SetupStep,
} from "./setup-state";

export type SetupPlatformGate = "verified" | "unverified" | "unsupported";
export type SetupCapabilityStatus = "ready" | "preparing" | "available" | "blocked-unverified" | "unsupported" | "not-delivered";

export interface SetupRuntimeSnapshot {
    builtinEmbeddingGate: SetupPlatformGate;
    localAiPhase: LocalAiPhase;
    coreReady: boolean;
    coreBusy: boolean;
    vectorJobPhase: VectorBuildJobPhase | null;
    graphJobPhase: GraphBuildJobPhase | null;
    mainLlmConfigured: boolean;
}

export interface SetupCapabilityMatrix {
    embedding: SetupCapabilityStatus;
    reranker: SetupCapabilityStatus;
    utility: SetupCapabilityStatus;
    graphRag: SetupCapabilityStatus;
}

export interface SetupViewState {
    persisted: PersistedSetupStateV1;
    step: SetupStep;
    shouldAutoOpen: boolean;
    capabilities: SetupCapabilityMatrix;
    coreReady: boolean;
    coreBusy: boolean;
    vectorJobPhase: VectorBuildJobPhase | null;
    graphJobPhase: GraphBuildJobPhase | null;
    mainLlmConfigured: boolean;
}

export interface SetupStateStore {
    get(): PersistedSetupStateV1;
    save(state: PersistedSetupStateV1): Promise<void>;
}

export interface SetupServiceDependencies {
    store: SetupStateStore;
    getRuntimeSnapshot(): SetupRuntimeSnapshot;
    now?(): number;
}

/** 可恢复的首次引导编排；不扫描 Vault、不下载模型，也不直接修改 provider 配置。 */
export class SetupService {
    private readonly now: () => number;

    constructor(private readonly dependencies: SetupServiceDependencies) {
        this.now = () => dependencies.now?.() ?? Date.now();
    }

    getState(): SetupViewState {
        const persisted = this.dependencies.store.get();
        const runtime = this.dependencies.getRuntimeSnapshot();
        return {
            persisted: cloneSetupState(persisted),
            step: deriveStep(persisted.lastStep, runtime),
            shouldAutoOpen: persisted.disposition === "pending" && persisted.entryReason === "new-install",
            capabilities: createCapabilityMatrix(runtime),
            coreReady: runtime.coreReady,
            coreBusy: runtime.coreBusy,
            vectorJobPhase: runtime.vectorJobPhase,
            graphJobPhase: runtime.graphJobPhase,
            mainLlmConfigured: runtime.mainLlmConfigured,
        };
    }

    async reopen(): Promise<SetupViewState> {
        await this.persist("scope", "pending", "manual");
        return this.getState();
    }

    async confirmScope(): Promise<SetupViewState> {
        this.requireStep(["scope"]);
        await this.persist("preparation", "pending");
        return this.getState();
    }

    async startBuiltinPreparation(): Promise<SetupViewState> {
        this.requireStep(["preparation"]);
        const runtime = this.dependencies.getRuntimeSnapshot();
        if (runtime.builtinEmbeddingGate !== "verified") {
            throw new Error("Built-in embedding is not verified for this platform.");
        }
        await this.persist(isPreparedPhase(runtime.localAiPhase) ? "ready-to-index" : "preparing", "pending");
        return this.getState();
    }

    async continueWithoutBuiltinEmbedding(): Promise<SetupViewState> {
        this.requireStep(["preparation", "preparing"]);
        await this.persist("ready-to-index", "pending");
        return this.getState();
    }

    async startIndexing(): Promise<SetupViewState> {
        this.requireStep(["ready-to-index"]);
        await this.persist("indexing", "pending");
        return this.getState();
    }

    async reconcileRuntime(): Promise<SetupViewState> {
        const persisted = this.dependencies.store.get();
        const derived = deriveStep(persisted.lastStep, this.dependencies.getRuntimeSnapshot());
        if (derived !== persisted.lastStep) await this.persist(derived, persisted.disposition);
        return this.getState();
    }

    async markSearchVerified(sourceCount: number): Promise<SetupViewState> {
        const runtime = this.dependencies.getRuntimeSnapshot();
        if (!runtime.coreReady || !Number.isSafeInteger(sourceCount) || sourceCount < 1) {
            throw new Error("A committed Core generation and at least one source are required.");
        }
        this.requireStep(["searchable"]);
        await this.persist("optional-main-llm", "pending");
        return this.getState();
    }

    async complete(): Promise<SetupViewState> {
        this.requireStep(["optional-main-llm", "searchable"]);
        await this.persist("complete", "completed");
        return this.getState();
    }

    async skip(): Promise<SetupViewState> {
        await this.persist("complete", "skipped");
        return this.getState();
    }

    private requireStep(allowed: SetupStep[]): void {
        const current = this.getState().step;
        if (!allowed.includes(current)) throw new Error(`Setup transition is not allowed from ${current}.`);
    }

    private async persist(
        lastStep: SetupStep,
        disposition: PersistedSetupStateV1["disposition"],
        entryReason: PersistedSetupStateV1["entryReason"] = this.dependencies.store.get().entryReason,
    ): Promise<void> {
        await this.dependencies.store.save({
            schemaVersion: SETUP_STATE_SCHEMA_VERSION,
            disposition,
            entryReason,
            lastStep,
            updatedAt: this.now(),
        });
    }
}

function deriveStep(step: SetupStep, runtime: SetupRuntimeSnapshot): SetupStep {
    if (step === "preparing" && isPreparedPhase(runtime.localAiPhase)) return "ready-to-index";
    if ((step === "indexing" || step === "ready-to-index") && runtime.coreReady) return "searchable";
    return step;
}

function createCapabilityMatrix(runtime: SetupRuntimeSnapshot): SetupCapabilityMatrix {
    let embedding: SetupCapabilityStatus;
    if (runtime.builtinEmbeddingGate === "unsupported") embedding = "unsupported";
    else if (runtime.builtinEmbeddingGate === "unverified") embedding = "blocked-unverified";
    else if (isPreparedPhase(runtime.localAiPhase)) embedding = "ready";
    else if (runtime.localAiPhase === "downloading" || runtime.localAiPhase === "loading" || runtime.localAiPhase === "clearing") embedding = "preparing";
    else embedding = "available";
    return {
        embedding,
        reranker: "not-delivered",
        utility: "not-delivered",
        graphRag: "not-delivered",
    };
}

function isPreparedPhase(phase: LocalAiPhase): boolean {
    return phase === "ready" || phase === "evicted";
}
