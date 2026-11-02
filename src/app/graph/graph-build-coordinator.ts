import type { KnowledgeBaseSyncResult } from "../../domain/documents/document-types";
import type { GraphRename, GraphSnapshotV1 } from "../../domain/graph/graph-types";
import type { SemanticGraphBuildProgress } from "../../domain/semantic-graph/semantic-graph-types";
import {
    GRAPH_BUILD_JOB_SCHEMA_VERSION,
    isGraphBuildJobTerminal,
    type GraphBuildCheckpoint,
    type GraphBuildJob,
    type GraphBuildJobPhase,
} from "../../domain/graph-jobs/graph-build-job";
import type { GraphBuildHooks } from "./knowledge-graph-service";
import type { SemanticGraphBuildHooks } from "../semantic-graph/semantic-graph-service";
import {
    createIndexTraceRef,
    type IndexLifecycleTrace,
    type IndexTraceSpan,
    type IndexTraceStatus,
} from "../observability/index-lifecycle-trace";

interface StructuralGraphRunner {
    rebuildAll(signal?: AbortSignal, hooks?: GraphBuildHooks): Promise<GraphSnapshotV1>;
    syncChangedFiles(
        syncResult: Pick<KnowledgeBaseSyncResult, "affectedFiles">,
        renames?: readonly GraphRename[],
        signal?: AbortSignal,
        hooks?: GraphBuildHooks,
    ): Promise<GraphSnapshotV1>;
}

interface SemanticGraphRunner {
    syncChangedFiles(
        syncResult: Pick<KnowledgeBaseSyncResult, "affectedFiles">,
        signal?: AbortSignal,
        hooks?: SemanticGraphBuildHooks,
    ): Promise<void>;
    reconcileWithCurrentSources(): Promise<void>;
}

export interface GraphBuildCoordinatorDependencies {
    structural: StructuralGraphRunner;
    semantic: SemanticGraphRunner;
    store: {
        load(): Promise<GraphBuildJob | null>;
        save(job: GraphBuildJob): Promise<void>;
        clear(): Promise<void>;
    };
    getActiveCoreGenerationId(): string | null;
    getGraphPolicyId(): string;
    onStateChanged(): void;
    now?: () => number;
    trace?: IndexLifecycleTrace;
}

/** 串行拥有结构图与可选语义派生作业；所有可恢复事实落盘，控制器仅存在于当前进程。 */
export class GraphBuildCoordinator {
    private sequence = 0;
    private activeJob: GraphBuildJob | null = null;
    private activeController: AbortController | null = null;
    private readonly completions = new Map<string, Promise<GraphBuildJob>>();
    private readonly suspendedJobIds = new Set<string>();
    private readonly traceSuspendedJobIds = new Set<string>();
    private readonly traceSpans = new Map<string, IndexTraceSpan>();
    private readonly now: () => number;

    constructor(private readonly dependencies: GraphBuildCoordinatorDependencies) {
        this.now = dependencies.now ?? (() => Date.now());
    }

    getState(): GraphBuildJob | null { return this.activeJob ? cloneJob(this.activeJob) : null; }

    isGenerationCompatible(snapshot: GraphSnapshotV1): boolean {
        if (!snapshot.sourceCoreGenerationId && !snapshot.graphPolicyId) return true;
        return snapshot.sourceCoreGenerationId === this.dependencies.getActiveCoreGenerationId()
            && snapshot.graphPolicyId === this.dependencies.getGraphPolicyId();
    }

    async restore(): Promise<GraphBuildJob | null> {
        const restored = await this.dependencies.store.load();
        if (!restored) return null;
        const identityChanged = !this.hasCurrentIdentity(restored);
        if (isGraphBuildJobTerminal(restored.phase)) {
            this.activeJob = restored.phase === "graph-ready" && identityChanged
                ? await this.transition(restored, "stale", "identity-changed")
                : restored;
            return this.getState();
        }
        if (identityChanged) {
            this.activeJob = await this.transition(restored, "superseded", "identity-changed");
            return this.getState();
        }
        return restored.mode === "full"
            ? await this.enqueueFull(restored.sourceCoreGenerationId, restored.reconcileSemanticSources)
            : await this.enqueueIncremental(
                restored.sourceCoreGenerationId,
                { affectedFiles: restored.affectedFiles },
                restored.renames,
            );
    }

    enqueueFull(sourceCoreGenerationId: string, reconcileSemanticSources: boolean): Promise<GraphBuildJob> {
        return this.enqueue({
            sourceCoreGenerationId,
            mode: "full",
            affectedFiles: [],
            renames: [],
            reconcileSemanticSources,
        });
    }

    enqueueIncremental(
        sourceCoreGenerationId: string,
        syncResult: Pick<KnowledgeBaseSyncResult, "affectedFiles">,
        renames: readonly GraphRename[],
    ): Promise<GraphBuildJob> {
        return this.enqueue({
            sourceCoreGenerationId,
            mode: "incremental",
            affectedFiles: Array.from(new Set(syncResult.affectedFiles)).sort(),
            renames: renames.map((rename) => ({ ...rename })),
            reconcileSemanticSources: false,
        });
    }

    async waitFor(jobId: string): Promise<GraphBuildJob> {
        const completion = this.completions.get(jobId);
        if (completion) return await completion;
        if (this.activeJob?.jobId === jobId && isGraphBuildJobTerminal(this.activeJob.phase)) return cloneJob(this.activeJob);
        throw new Error(`Unknown graph build job: ${jobId}`);
    }

    cancel(): void { this.activeController?.abort(new DOMException("Graph build cancelled.", "AbortError")); }

    suspend(): void {
        const job = this.activeJob;
        if (!job || isGraphBuildJobTerminal(job.phase)) return;
        this.suspendedJobIds.add(job.jobId);
        this.traceSuspendedJobIds.add(job.jobId);
        this.activeController?.abort(new DOMException("Graph build suspended for shutdown.", "AbortError"));
    }

    async clear(): Promise<void> {
        const jobId = this.activeJob?.jobId;
        this.cancel();
        if (jobId) await this.completions.get(jobId)?.catch(() => undefined);
        this.activeJob = null;
        await this.dependencies.store.clear();
        this.dependencies.onStateChanged();
    }

    dispose(): void { this.suspend(); }

    private async enqueue(input: {
        sourceCoreGenerationId: string;
        mode: "full" | "incremental";
        affectedFiles: string[];
        renames: GraphRename[];
        reconcileSemanticSources: boolean;
    }): Promise<GraphBuildJob> {
        if (this.activeJob && !isGraphBuildJobTerminal(this.activeJob.phase)) {
            const superseded = {
                ...this.activeJob,
                phase: "superseded" as const,
                errorCode: "new-core-generation",
                updatedAt: this.now(),
            };
            this.activeJob = superseded;
            this.activeController?.abort(new DOMException("Graph build superseded.", "AbortError"));
            await this.dependencies.store.save(superseded);
            this.dependencies.onStateChanged();
        }
        const timestamp = this.now();
        const job: GraphBuildJob = {
            schemaVersion: GRAPH_BUILD_JOB_SCHEMA_VERSION,
            jobId: `graph-job-${timestamp}-${++this.sequence}`,
            sourceCoreGenerationId: input.sourceCoreGenerationId,
            graphPolicyId: this.dependencies.getGraphPolicyId(),
            mode: input.mode,
            phase: "queued",
            affectedFiles: [...input.affectedFiles],
            renames: input.renames.map((rename) => ({ ...rename })),
            reconcileSemanticSources: input.reconcileSemanticSources,
            checkpoint: emptyCheckpoint(),
            createdAt: timestamp,
            updatedAt: timestamp,
            errorCode: null,
        };
        this.activeJob = job;
        await this.dependencies.store.save(job);
        this.dependencies.onStateChanged();
        const controller = new AbortController();
        this.activeController = controller;
        const traceSpan = this.dependencies.trace?.begin("graph-job.run", {
            jobRef: createIndexTraceRef("job", job.jobId),
            generationRef: createIndexTraceRef("generation", job.sourceCoreGenerationId),
            policyRef: createIndexTraceRef("policy", job.graphPolicyId),
            role: "graph",
        });
        if (traceSpan) this.traceSpans.set(job.jobId, traceSpan);
        const completion = this.run(job, controller).then((result) => {
            const suspended = this.traceSuspendedJobIds.delete(result.jobId);
            traceSpan?.finish(suspended ? "suspended" : graphTraceStatus(result.phase), result.errorCode, {
                processed: result.checkpoint.processedSections,
                failed: result.checkpoint.failedSections,
                queued: result.checkpoint.queuedSections,
            });
            return result;
        }, (error: unknown) => {
            traceSpan?.finish("failed", "graph-job-unhandled");
            throw error;
        }).finally(() => {
            this.traceSpans.delete(job.jobId);
            if (this.activeController === controller) this.activeController = null;
        });
        this.completions.set(job.jobId, completion);
        void completion.finally(() => this.completions.delete(job.jobId));
        return cloneJob(job);
    }

    private async run(job: GraphBuildJob, controller: AbortController): Promise<GraphBuildJob> {
        const snapshotSpan = this.dependencies.trace?.begin("graph.snapshot", {
            jobRef: createIndexTraceRef("job", job.jobId),
            generationRef: createIndexTraceRef("generation", job.sourceCoreGenerationId),
            policyRef: createIndexTraceRef("policy", job.graphPolicyId),
            role: "graph",
        });
        try {
            const graphHooks: GraphBuildHooks = {
                sourceCoreGenerationId: job.sourceCoreGenerationId,
                graphPolicyId: job.graphPolicyId,
                beforeActivate: () => {
                    this.requireCurrentIdentity(job, controller.signal);
                    snapshotSpan?.finish("completed");
                    this.dependencies.trace?.instant("graph.activate", {
                        jobRef: createIndexTraceRef("job", job.jobId),
                        generationRef: createIndexTraceRef("generation", job.sourceCoreGenerationId),
                        policyRef: createIndexTraceRef("policy", job.graphPolicyId),
                        role: "graph",
                    });
                },
                onPhase: async (phase) => { await this.updateActive(job.jobId, phase); },
            };
            if (job.mode === "full") {
                await this.dependencies.structural.rebuildAll(controller.signal, graphHooks);
            } else {
                await this.dependencies.structural.syncChangedFiles(
                    { affectedFiles: job.affectedFiles },
                    job.renames,
                    controller.signal,
                    graphHooks,
                );
            }
            snapshotSpan?.finish("completed");
            this.requireCurrentIdentity(job, controller.signal);
            if (job.mode === "full" && job.reconcileSemanticSources) {
                await this.dependencies.semantic.reconcileWithCurrentSources();
            } else if (job.mode === "incremental") {
                await this.dependencies.semantic.syncChangedFiles(
                    { affectedFiles: job.affectedFiles },
                    controller.signal,
                    {
                        onPhase: async (phase) => { await this.updateActive(job.jobId, phase); },
                        onCheckpoint: async (progress) => { await this.updateCheckpoint(job.jobId, progress); },
                    },
                );
            }
            this.requireCurrentIdentity(job, controller.signal);
            return await this.updateActive(job.jobId, "graph-ready");
        } catch (error: unknown) {
            snapshotSpan?.finish(
                isAbortError(error) ? "cancelled" : error instanceof StaleGraphBuildError ? "stale" : "failed",
                isAbortError(error) ? "aborted" : error instanceof StaleGraphBuildError ? "identity-changed" : "graph-snapshot-failed",
            );
            const latest = this.activeJob;
            if (this.suspendedJobIds.delete(job.jobId)) {
                return latest?.jobId === job.jobId ? cloneJob(latest) : cloneJob(job);
            }
            if (!latest || latest.jobId !== job.jobId) {
                return cloneJob({ ...job, phase: "superseded", errorCode: "new-core-generation", updatedAt: this.now() });
            }
            if (latest.phase === "superseded") return cloneJob(latest);
            if (isAbortError(error)) return await this.updateActive(job.jobId, "cancelled", "aborted");
            if (error instanceof StaleGraphBuildError) return await this.updateActive(job.jobId, "stale", "identity-changed");
            return await this.updateActive(job.jobId, "failed", "graph-build-failed");
        }
    }

    private requireCurrentIdentity(job: GraphBuildJob, signal: AbortSignal): void {
        signal.throwIfAborted();
        if (!this.hasCurrentIdentity(job)) throw new StaleGraphBuildError();
    }

    private hasCurrentIdentity(job: GraphBuildJob): boolean {
        return this.dependencies.getActiveCoreGenerationId() === job.sourceCoreGenerationId
            && this.dependencies.getGraphPolicyId() === job.graphPolicyId;
    }

    private async updateCheckpoint(jobId: string, progress: SemanticGraphBuildProgress): Promise<GraphBuildJob> {
        const current = this.requireActiveJob(jobId);
        const next = {
            ...current,
            checkpoint: {
                processedSections: progress.processedSections,
                failedSections: progress.failedSections,
                queuedSections: progress.queuedSections,
            },
            updatedAt: this.now(),
        };
        this.activeJob = next;
        await this.dependencies.store.save(next);
        this.traceSpans.get(jobId)?.checkpoint({
            processed: progress.processedSections,
            failed: progress.failedSections,
            queued: progress.queuedSections,
        });
        this.dependencies.onStateChanged();
        return cloneJob(next);
    }

    private async updateActive(jobId: string, phase: GraphBuildJobPhase, errorCode: string | null = null): Promise<GraphBuildJob> {
        const current = this.requireActiveJob(jobId);
        const next = await this.transition(current, phase, errorCode);
        this.activeJob = next;
        this.dependencies.onStateChanged();
        return cloneJob(next);
    }

    private requireActiveJob(jobId: string): GraphBuildJob {
        if (!this.activeJob || this.activeJob.jobId !== jobId) throw new StaleGraphBuildError();
        return this.activeJob;
    }

    private async transition(job: GraphBuildJob, phase: GraphBuildJobPhase, errorCode: string | null): Promise<GraphBuildJob> {
        const next = { ...job, phase, errorCode, updatedAt: this.now() };
        await this.dependencies.store.save(next);
        return next;
    }
}

class StaleGraphBuildError extends Error {}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function emptyCheckpoint(): GraphBuildCheckpoint {
    return { processedSections: 0, failedSections: 0, queuedSections: 0 };
}

function cloneJob(job: GraphBuildJob): GraphBuildJob {
    return {
        ...job,
        affectedFiles: [...job.affectedFiles],
        renames: job.renames.map((rename) => ({ ...rename })),
        checkpoint: { ...job.checkpoint },
    };
}

function graphTraceStatus(phase: GraphBuildJobPhase): Exclude<IndexTraceStatus, "started" | "checkpoint"> {
    if (phase === "graph-ready") return "completed";
    if (phase === "cancelled") return "cancelled";
    if (phase === "superseded") return "superseded";
    if (phase === "stale") return "stale";
    return "failed";
}
