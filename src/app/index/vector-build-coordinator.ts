import type { VectorIndexStats } from "../../domain/retrieval/retrieval-types";
import {
    VECTOR_BUILD_JOB_SCHEMA_VERSION,
    isVectorBuildJobTerminal,
    type VectorBuildJob,
    type VectorBuildJobPhase,
} from "../../domain/index-jobs/vector-build-job";

interface VectorBuildRunner {
    rebuildVectorIndex(
        signal?: AbortSignal,
        hooks?: {
            beforeActivate(): void;
            onPhase?(phase: "embedding" | "persisting-vector" | "validating"): void | Promise<void>;
            sourceCoreGenerationId?: string;
        },
    ): Promise<VectorIndexStats>;
}

export interface VectorBuildCoordinatorDependencies {
    runner: VectorBuildRunner;
    store: {
        load(): Promise<VectorBuildJob | null>;
        save(job: VectorBuildJob): Promise<void>;
        clear(): Promise<void>;
    };
    getActiveCoreGenerationId(): string | null;
    getEmbeddingPolicyId(): string;
    onStateChanged(): void;
    now?: () => number;
}

/** 持久化后台向量作业；Promise/AbortController 只存在于当前进程，不写入 job 事实。 */
export class VectorBuildCoordinator {
    private sequence = 0;
    private activeJob: VectorBuildJob | null = null;
    private activeController: AbortController | null = null;
    private readonly completions = new Map<string, Promise<VectorBuildJob>>();
    private readonly now: () => number;

    constructor(private readonly dependencies: VectorBuildCoordinatorDependencies) {
        this.now = dependencies.now ?? (() => Date.now());
    }

    getState(): VectorBuildJob | null { return this.activeJob ? { ...this.activeJob } : null; }

    async restore(): Promise<VectorBuildJob | null> {
        const restored = await this.dependencies.store.load();
        if (!restored) return null;
        if (isVectorBuildJobTerminal(restored.phase)) {
            const identityChanged = this.dependencies.getActiveCoreGenerationId() !== restored.sourceCoreGenerationId
                || this.dependencies.getEmbeddingPolicyId() !== restored.embeddingPolicyId;
            this.activeJob = restored.phase === "rag-ready" && identityChanged
                ? await this.transition(restored, "stale", "identity-changed")
                : restored;
            return this.getState();
        }
        const activeCore = this.dependencies.getActiveCoreGenerationId();
        if (activeCore !== restored.sourceCoreGenerationId
            || this.dependencies.getEmbeddingPolicyId() !== restored.embeddingPolicyId) {
            this.activeJob = await this.transition(restored, "superseded", "identity-changed");
            return this.getState();
        }
        return await this.enqueue(restored.sourceCoreGenerationId);
    }

    async enqueue(sourceCoreGenerationId: string): Promise<VectorBuildJob> {
        if (this.activeJob && !isVectorBuildJobTerminal(this.activeJob.phase)) {
            this.activeController?.abort(new DOMException("Vector build superseded.", "AbortError"));
            this.activeJob = await this.transition(this.activeJob, "superseded", "new-core-generation");
        }
        const timestamp = this.now();
        const job: VectorBuildJob = {
            schemaVersion: VECTOR_BUILD_JOB_SCHEMA_VERSION,
            jobId: `vector-job-${timestamp}-${++this.sequence}`,
            sourceCoreGenerationId,
            embeddingPolicyId: this.dependencies.getEmbeddingPolicyId(),
            phase: "queued",
            createdAt: timestamp,
            updatedAt: timestamp,
            vectorCount: 0,
            errorCode: null,
        };
        this.activeJob = job;
        await this.dependencies.store.save(job);
        this.dependencies.onStateChanged();
        const controller = new AbortController();
        this.activeController = controller;
        const completion = this.run(job, controller).finally(() => {
            if (this.activeController === controller) this.activeController = null;
        });
        this.completions.set(job.jobId, completion);
        void completion.finally(() => this.completions.delete(job.jobId));
        return { ...job };
    }

    async waitFor(jobId: string): Promise<VectorBuildJob> {
        const completion = this.completions.get(jobId);
        if (completion) return await completion;
        const state = this.activeJob;
        if (state?.jobId === jobId && isVectorBuildJobTerminal(state.phase)) return { ...state };
        throw new Error(`Unknown vector build job: ${jobId}`);
    }

    cancel(): void {
        this.activeController?.abort(new DOMException("Vector build cancelled.", "AbortError"));
    }

    async clear(): Promise<void> {
        const jobId = this.activeJob?.jobId;
        this.cancel();
        if (jobId) await this.completions.get(jobId)?.catch(() => undefined);
        this.activeJob = null;
        await this.dependencies.store.clear();
        this.dependencies.onStateChanged();
    }

    dispose(): void { this.cancel(); }

    private async run(job: VectorBuildJob, controller: AbortController): Promise<VectorBuildJob> {
        try {
            await this.updateActive(job.jobId, "preparing-model");
            const stats = await this.dependencies.runner.rebuildVectorIndex(controller.signal, {
                beforeActivate: () => this.requireCurrentIdentity(job, controller.signal),
                onPhase: async (phase) => { await this.updateActive(job.jobId, phase); },
                sourceCoreGenerationId: job.sourceCoreGenerationId,
            });
            this.requireCurrentIdentity(job, controller.signal);
            return await this.updateActive(job.jobId, "rag-ready", null, stats.vectorCount);
        } catch (error: unknown) {
            const latest = this.activeJob;
            if (!latest || latest.jobId !== job.jobId || latest.phase === "superseded") return latest ? { ...latest } : { ...job, phase: "superseded" };
            if (isAbortError(error)) return await this.updateActive(job.jobId, "cancelled", "aborted");
            if (error instanceof StaleVectorBuildError) return await this.updateActive(job.jobId, "stale", "identity-changed");
            return await this.updateActive(job.jobId, "failed", "vector-build-failed");
        }
    }

    private requireCurrentIdentity(job: VectorBuildJob, signal: AbortSignal): void {
        signal.throwIfAborted();
        if (this.dependencies.getActiveCoreGenerationId() !== job.sourceCoreGenerationId
            || this.dependencies.getEmbeddingPolicyId() !== job.embeddingPolicyId) throw new StaleVectorBuildError();
    }

    private async updateActive(
        jobId: string,
        phase: VectorBuildJobPhase,
        errorCode: string | null = null,
        vectorCount?: number,
    ): Promise<VectorBuildJob> {
        const current = this.activeJob;
        if (!current || current.jobId !== jobId) throw new StaleVectorBuildError();
        const next = await this.transition(current, phase, errorCode, vectorCount);
        this.activeJob = next;
        this.dependencies.onStateChanged();
        return { ...next };
    }

    private async transition(
        job: VectorBuildJob,
        phase: VectorBuildJobPhase,
        errorCode: string | null,
        vectorCount: number = job.vectorCount,
    ): Promise<VectorBuildJob> {
        const next = { ...job, phase, errorCode, vectorCount, updatedAt: this.now() };
        await this.dependencies.store.save(next);
        return next;
    }
}

class StaleVectorBuildError extends Error {}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}
