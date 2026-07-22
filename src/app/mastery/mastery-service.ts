import type { AssessmentSessionDocumentV1, AssessmentSessionStore } from "../../domain/assessment/assessment-types";
import type { GraphCapacityAssessment } from "../../domain/graph-capacity/graph-capacity-types";
import { MasteryBindingResolver } from "../../domain/mastery/mastery-binding-resolver";
import { MasteryEngine } from "../../domain/mastery/mastery-engine";
import { MasteryIntegrityService } from "../../domain/mastery/mastery-integrity";
import {
    DEFAULT_MASTERY_ALGORITHM,
    MASTERY_SNAPSHOT_SCHEMA_VERSION,
    type ConceptMasteryState,
    type MasteryAssessmentInput,
    type MasteryConceptCatalogReader,
    type MasterySnapshotV1,
    type MasteryStateView,
    type MasteryStore,
} from "../../domain/mastery/mastery-types";

export interface MasteryServiceDependencies {
    assessmentSessionStore: AssessmentSessionStore;
    catalogReader: MasteryConceptCatalogReader;
    store: MasteryStore;
    getCapacityAssessment(): GraphCapacityAssessment;
    getNow?(): number;
}

export interface MasterySyncResult {
    updated: boolean;
    recalculatedConceptIds: string[];
    reason?: "capacity" | "source-unavailable" | "no-affected-concepts";
}

/**
 * Application-level coordinator for the rebuildable M4B mastery cache.
 * It never writes Assessment evidence and an incremental exam update only
 * recalculates Concepts directly touched by that session's explicit bindings.
 */
export class MasteryService {
    private readonly engine = new MasteryEngine();
    private readonly resolver = new MasteryBindingResolver();
    private readonly integrity = new MasteryIntegrityService();
    private snapshot: MasterySnapshotV1 | null = null;
    private dirty = false;
    private busy = false;
    private lastError: string | null = null;

    constructor(private readonly dependencies: MasteryServiceDependencies) {}

    async load(): Promise<void> {
        try {
            const snapshot = await this.dependencies.store.load();
            if (snapshot) this.assertSnapshot(snapshot);
            this.snapshot = snapshot;
            this.dirty = snapshot === null || snapshot.algorithmVersion !== DEFAULT_MASTERY_ALGORITHM.version;
            this.lastError = snapshot && this.dirty ? "掌握度算法版本已变更，需要重新计算。" : null;
        } catch (error: unknown) {
            this.snapshot = null;
            this.dirty = true;
            this.lastError = describeError(error);
        }
    }

    getState(): MasteryStateView {
        return {
            hasSnapshot: this.snapshot !== null,
            dirty: this.dirty,
            busy: this.busy,
            lastError: this.lastError,
            algorithmVersion: this.snapshot?.algorithmVersion ?? null,
            stateCount: this.snapshot?.states.length ?? 0,
            sourceEventCount: this.snapshot?.sourceEventCount ?? 0,
            unboundIssueCount: this.snapshot?.unboundIssues.length ?? 0,
        };
    }

    getSnapshot(): MasterySnapshotV1 | null {
        return this.snapshot ? cloneSnapshot(this.snapshot) : null;
    }

    getConceptState(conceptId: string): ConceptMasteryState | null {
        const state = this.snapshot?.states.find((item) => item.conceptId === conceptId);
        return state ? cloneState(state) : null;
    }

    /** Marks existing numbers as stale without deleting the last readable cache. */
    markDirty(reason: string | null = null): void {
        this.dirty = true;
        if (reason) this.lastError = reason;
    }

    async clear(): Promise<void> {
        if (this.busy) throw new Error("掌握度计算正在运行，暂时无法清除快照。");
        await this.dependencies.store.clear();
        this.snapshot = null;
        this.dirty = false;
        this.lastError = null;
    }

    async rebuildAll(): Promise<MasterySnapshotV1> {
        this.assertCanCalculate();
        return this.run(async () => {
            const catalog = this.dependencies.catalogReader.getConceptCatalog();
            assertCatalogReady(catalog.sourceReady, catalog.message);
            const now = this.now();
            const result = this.engine.calculateAll({
                catalog,
                assessments: await this.listAssessments(),
                now,
            });
            const snapshot: MasterySnapshotV1 = {
                schemaVersion: MASTERY_SNAPSHOT_SCHEMA_VERSION,
                algorithmVersion: DEFAULT_MASTERY_ALGORITHM.version,
                calculatedAt: now,
                states: result.states,
                sourceEventCount: result.sourceEventCount,
                unboundIssues: result.unboundIssues,
            };
            this.assertSnapshot(snapshot);
            await this.dependencies.store.save(snapshot);
            this.snapshot = snapshot;
            this.dirty = false;
            this.lastError = null;
            return cloneSnapshot(snapshot);
        });
    }

    /**
     * Called after evidence JSON is safely written. A capacity/source problem is
     * intentionally non-fatal here: saving an Exam must remain independent from
     * this disposable calculation.
     */
    async syncForSession(document: AssessmentSessionDocumentV1): Promise<MasterySyncResult> {
        if (!this.isCalculationAllowed()) {
            this.markDirty("当前知识库规模建议使用独立服务；本地掌握度快照已保留，未进行增量计算。");
            return { updated: false, recalculatedConceptIds: [], reason: "capacity" };
        }
        const catalog = this.dependencies.catalogReader.getConceptCatalog();
        if (!catalog.sourceReady) {
            this.markDirty(catalog.message ?? "知识图谱尚未准备好，无法计算掌握度。");
            return { updated: false, recalculatedConceptIds: [], reason: "source-unavailable" };
        }
        if (!this.snapshot || this.snapshot.algorithmVersion !== DEFAULT_MASTERY_ALGORITHM.version) {
            await this.rebuildAll();
            return {
                updated: true,
                recalculatedConceptIds: catalog.concepts.map((concept) => concept.id),
            };
        }

        return this.run(async () => {
            const allAssessments = await this.listAssessments();
            const analysis = this.engine.analyze({ catalog, assessments: allAssessments });
            // Include superseded events from this session too, so a re-evaluation
            // can remove its prior contribution from the same Concept state.
            const sessionResolution = this.resolver.resolve(toAssessmentInputs([document]), catalog);
            const affectedConceptIds = Array.from(new Set(sessionResolution.resolved.map((item) => item.conceptId)))
                .sort((left, right) => left.localeCompare(right));
            const now = this.now();
            const recalculated = this.engine.recalculateConcepts({
                catalog,
                assessments: allAssessments,
                now,
            }, affectedConceptIds);
            const replacementById = new Map(recalculated.map((state) => [state.conceptId, state]));
            const states = this.snapshot!.states
                .map((state) => replacementById.get(state.conceptId) ?? state)
                .sort((left, right) => left.conceptId.localeCompare(right.conceptId));
            const next: MasterySnapshotV1 = {
                ...this.snapshot!,
                calculatedAt: now,
                states,
                sourceEventCount: analysis.activeAssessments.length,
                unboundIssues: analysis.unboundIssues,
            };
            this.assertSnapshot(next);
            await this.dependencies.store.save(next);
            this.snapshot = next;
            this.dirty = false;
            this.lastError = null;
            return {
                updated: affectedConceptIds.length > 0,
                recalculatedConceptIds: affectedConceptIds,
                ...(affectedConceptIds.length === 0 ? { reason: "no-affected-concepts" as const } : {}),
            };
        });
    }

    private async listAssessments(): Promise<MasteryAssessmentInput[]> {
        return toAssessmentInputs(await this.dependencies.assessmentSessionStore.list());
    }

    private assertCanCalculate(): void {
        if (!this.isCalculationAllowed()) {
            throw new Error("当前知识库规模建议使用独立服务，已阻止新的本地掌握度计算。");
        }
    }

    private isCalculationAllowed(): boolean {
        const level = this.dependencies.getCapacityAssessment().level;
        return level === "local" || level === "warning";
    }

    private async run<T>(work: () => Promise<T>): Promise<T> {
        if (this.busy) throw new Error("掌握度计算正在运行。");
        this.busy = true;
        try {
            return await work();
        } catch (error: unknown) {
            this.dirty = true;
            this.lastError = describeError(error);
            throw error;
        } finally {
            this.busy = false;
        }
    }

    private assertSnapshot(snapshot: MasterySnapshotV1): void {
        const report = this.integrity.check(snapshot);
        if (!report.valid) throw new Error(`掌握度快照完整性校验失败：${report.issues.join(", ")}`);
    }

    private now(): number {
        return this.dependencies.getNow?.() ?? Date.now();
    }
}

function toAssessmentInputs(documents: readonly AssessmentSessionDocumentV1[]): MasteryAssessmentInput[] {
    return [...documents]
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .flatMap((document) => document.assessmentEvents
            .map((event) => ({ event, conceptBindings: document.conceptBindings }))
            .sort((left, right) => left.event.id.localeCompare(right.event.id)));
}

function assertCatalogReady(sourceReady: boolean, message: string | null): asserts sourceReady {
    if (!sourceReady) throw new Error(message ?? "知识图谱尚未准备好，无法计算掌握度。");
}

function cloneSnapshot(snapshot: MasterySnapshotV1): MasterySnapshotV1 {
    return {
        ...snapshot,
        states: snapshot.states.map(cloneState),
        unboundIssues: snapshot.unboundIssues.map((issue) => ({
            ...issue,
            candidateConceptIds: issue.candidateConceptIds ? [...issue.candidateConceptIds] : undefined,
        })),
    };
}

function cloneState(state: ConceptMasteryState): ConceptMasteryState {
    return {
        ...state,
        commonErrorCodes: [...state.commonErrorCodes],
        evidence: state.evidence.map((evidence) => ({ ...evidence, errorCodes: [...evidence.errorCodes] })),
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
