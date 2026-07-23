import type { AssessmentSessionStore } from "../../domain/assessment/assessment-types";
import type { ExamHistoryItem } from "../../domain/exam/exam-types";
import type { LearningGraphConceptCatalog } from "../../domain/learning-graph/learning-graph-types";
import type { MasterySnapshotV1, MasteryStateView } from "../../domain/mastery/mastery-types";
import {
    PROGRESS_SNAPSHOT_SCHEMA_VERSION,
    type ProgressAssessmentSummary,
    type ProgressGraphSummary,
    type ProgressMasteryStatus,
    type ProgressMasterySummary,
    type ProgressSnapshot,
} from "./progress-types";

export interface ProgressCatalogReader {
    getConceptCatalog(): LearningGraphConceptCatalog;
}

export interface ProgressMasteryReader {
    getState(): MasteryStateView;
    getSnapshot(): MasterySnapshotV1 | null;
}

export interface ProgressServiceDependencies {
    catalogReader: ProgressCatalogReader;
    masteryReader: ProgressMasteryReader;
    assessmentSessionStore: Pick<AssessmentSessionStore, "listHistory">;
    getNow?(): number;
}

/**
 * Composes existing application facts into a disposable, UI-safe Progress
 * read model. The service owns no persistence and never reads renderer
 * projections, semantic candidates, or Markdown report files.
 */
export class ProgressService {
    constructor(private readonly dependencies: ProgressServiceDependencies) {}

    async getSnapshot(): Promise<ProgressSnapshot> {
        const catalogResult = readCatalog(this.dependencies.catalogReader);
        const mastery = readMastery(
            this.dependencies.masteryReader,
            catalogResult.catalog,
            catalogResult.summary,
        );
        const assessments = await readAssessmentHistory(this.dependencies.assessmentSessionStore);

        return {
            schemaVersion: PROGRESS_SNAPSHOT_SCHEMA_VERSION,
            generatedAt: this.dependencies.getNow?.() ?? Date.now(),
            graph: catalogResult.summary,
            mastery,
            assessments,
            // M7 owns RecommendationService. This stable empty value avoids a
            // future Dashboard API shape change.
            recommendations: [],
        };
    }
}

function readCatalog(reader: ProgressCatalogReader): {
    catalog: LearningGraphConceptCatalog | null;
    summary: ProgressGraphSummary;
} {
    try {
        const catalog = reader.getConceptCatalog();
        if (!catalog.sourceReady) {
            return {
                catalog: null,
                summary: {
                    status: "unavailable",
                    conceptCount: 0,
                    message: catalog.message ?? "Learning graph is unavailable.",
                },
            };
        }
        return {
            catalog,
            summary: {
                status: "ready",
                conceptCount: catalog.concepts.length,
                message: catalog.message,
            },
        };
    } catch (error: unknown) {
        return {
            catalog: null,
            summary: {
                status: "unavailable",
                conceptCount: 0,
                message: describeError(error),
            },
        };
    }
}

function readMastery(
    reader: ProgressMasteryReader,
    catalog: LearningGraphConceptCatalog | null,
    graph: ProgressGraphSummary,
): ProgressMasterySummary {
    try {
        const state = reader.getState();
        const snapshot = reader.getSnapshot();
        const status = getMasteryStatus(state, snapshot, graph);
        if (!snapshot || !catalog) {
            return createUnavailableMasterySummary(state, snapshot, catalog?.concepts.length ?? 0, status);
        }

        const currentConceptIds = new Set(catalog.concepts.map((concept) => concept.id));
        const states = snapshot.states.filter((item) => currentConceptIds.has(item.conceptId));
        const levelCounts = createLevelCounts();
        let assessedConceptCount = 0;
        for (const item of states) {
            levelCounts[item.level] += 1;
            if (item.effectiveEvidenceCount > 0) assessedConceptCount += 1;
        }
        const conceptCount = catalog.concepts.length;
        return {
            status,
            message: state.lastError,
            conceptCount,
            assessedConceptCount,
            coverageRatio: conceptCount === 0 ? null : assessedConceptCount / conceptCount,
            levelCounts,
            snapshotCalculatedAt: snapshot.calculatedAt,
            algorithmVersion: snapshot.algorithmVersion,
            sourceEventCount: snapshot.sourceEventCount,
            unboundIssueCount: snapshot.unboundIssues.length,
        };
    } catch (error: unknown) {
        return {
            status: "unavailable",
            message: describeError(error),
            conceptCount: catalog?.concepts.length ?? 0,
            assessedConceptCount: 0,
            coverageRatio: null,
            levelCounts: createLevelCounts(),
            snapshotCalculatedAt: null,
            algorithmVersion: null,
            sourceEventCount: 0,
            unboundIssueCount: 0,
        };
    }
}

function getMasteryStatus(
    state: MasteryStateView,
    snapshot: MasterySnapshotV1 | null,
    graph: ProgressGraphSummary,
): ProgressMasteryStatus {
    if (state.busy) return "calculating";
    if (!snapshot) return "missing";
    if (state.dirty || graph.status !== "ready") return "stale";
    return "current";
}

function createUnavailableMasterySummary(
    state: MasteryStateView,
    snapshot: MasterySnapshotV1 | null,
    conceptCount: number,
    status: ProgressMasteryStatus,
): ProgressMasterySummary {
    return {
        status,
        message: state.lastError,
        conceptCount,
        assessedConceptCount: 0,
        coverageRatio: null,
        levelCounts: createLevelCounts(),
        snapshotCalculatedAt: snapshot?.calculatedAt ?? null,
        algorithmVersion: snapshot?.algorithmVersion ?? null,
        sourceEventCount: snapshot?.sourceEventCount ?? 0,
        unboundIssueCount: snapshot?.unboundIssues.length ?? 0,
    };
}

async function readAssessmentHistory(
    store: Pick<AssessmentSessionStore, "listHistory">,
): Promise<ProgressAssessmentSummary> {
    try {
        const history = await store.listHistory();
        return {
            status: "ready",
            message: null,
            sessionCount: history.length,
            scoredSessionCount: history.filter((item) => item.score !== null).length,
            latestSessionAt: findLatestHistoryTime(history),
        };
    } catch (error: unknown) {
        return {
            status: "unavailable",
            message: describeError(error),
            sessionCount: 0,
            scoredSessionCount: 0,
            latestSessionAt: null,
        };
    }
}

function findLatestHistoryTime(history: readonly ExamHistoryItem[]): number | null {
    let latest: number | null = null;
    for (const item of history) {
        const candidate = item.modifiedAt ?? item.createdAt ?? null;
        if (candidate !== null && (latest === null || candidate > latest)) {
            latest = candidate;
        }
    }
    return latest;
}

function createLevelCounts(): Record<"unknown" | "weak" | "developing" | "proficient" | "mastered", number> {
    return {
        unknown: 0,
        weak: 0,
        developing: 0,
        proficient: 0,
        mastered: 0,
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
