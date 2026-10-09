import type { AssessmentSessionStore } from "../../domain/assessment/assessment-types";
import type { ExamHistoryItem } from "../../domain/exam/exam-types";
import type { LearningGraphConceptCatalog } from "../../domain/learning-graph/learning-graph-types";
import type { MasterySnapshotV1, MasteryStateView } from "../../domain/mastery/mastery-types";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation-types";
import {
    PROGRESS_SNAPSHOT_SCHEMA_VERSION,
    type ProgressAssessmentSummary,
    type ProgressGraphSummary,
    type ProgressMasteryStatus,
    type ProgressMasterySummary,
    type ProgressSnapshot,
    type ProgressStateView,
} from "./progress-types";

/** Progress 聚合对学习图概念目录的只读端口。 */
export interface ProgressCatalogReader {
    getConceptCatalog(): LearningGraphConceptCatalog;
}

/** Progress 聚合对掌握度状态和快照的只读端口。 */
export interface ProgressMasteryReader {
    getState(): MasteryStateView;
    getSnapshot(): MasterySnapshotV1 | null;
}

/** Progress 快照构建所需的事实读取端口；所有来源都必须保持只读。 */
export interface ProgressServiceDependencies {
    catalogReader: ProgressCatalogReader;
    masteryReader: ProgressMasteryReader;
    assessmentSessionStore: Pick<AssessmentSessionStore, "listHistory">;
    recommendationReader?: { getSnapshot(): Promise<RecommendationSnapshot> };
    getNow?(): number;
}

/**
 * 将现有应用事实组合成可重建且可安全用于 UI 的 Progress 只读模型。
 *
 * 本服务不负责持久化，也不得读取渲染投影、语义候选或 Markdown 报告文件。
 */
export class ProgressService {
    private snapshot: ProgressSnapshot | null = null;
    private dirty = true;
    private busy = false;
    private lastError: string | null = null;
    private revision = 0;
    private inFlightRead: Promise<ProgressSnapshot> | null = null;

    constructor(private readonly dependencies: ProgressServiceDependencies) {}

    async getSnapshot(): Promise<ProgressSnapshot> {
        while (true) {
            if (this.snapshot && !this.dirty) {
                return cloneSnapshot(this.snapshot);
            }
            await (this.inFlightRead ?? this.startRead());
        }
    }

    getState(): ProgressStateView {
        return {
            hasSnapshot: this.snapshot !== null,
            dirty: this.dirty,
            busy: this.busy,
            lastError: this.lastError,
            generatedAt: this.snapshot?.generatedAt ?? null,
        };
    }

    /**
     * 只使可重建只读模型失效。下次消费者显式读取时再惰性重建，
     * 确保启动和来源变更事件不会自行扫描 Vault 或枚举 Assessment 历史。
     */
    invalidate(): void {
        this.revision += 1;
        this.dirty = true;
    }

    private startRead(): Promise<ProgressSnapshot> {
        const sourceRevision = this.revision;
        this.busy = true;
        let request: Promise<ProgressSnapshot>;
        request = this.createSnapshot()
            .then((snapshot) => {
                if (sourceRevision === this.revision) {
                    this.snapshot = cloneSnapshot(snapshot);
                    this.dirty = false;
                    this.lastError = null;
                }
                return snapshot;
            })
            .catch((error: unknown) => {
                this.dirty = true;
                this.lastError = describeError(error);
                throw error;
            })
            .finally(() => {
                if (this.inFlightRead === request) {
                    this.inFlightRead = null;
                    this.busy = false;
                }
            });
        this.inFlightRead = request;
        return request;
    }

    private async createSnapshot(): Promise<ProgressSnapshot> {
        const catalogResult = readCatalog(this.dependencies.catalogReader);
        const mastery = readMastery(
            this.dependencies.masteryReader,
            catalogResult.catalog,
            catalogResult.summary,
        );
        const [assessments, recommendations] = await Promise.all([
            readAssessmentHistory(this.dependencies.assessmentSessionStore),
            readRecommendations(this.dependencies.recommendationReader),
        ]);

        return {
            schemaVersion: PROGRESS_SNAPSHOT_SCHEMA_VERSION,
            generatedAt: this.dependencies.getNow?.() ?? Date.now(),
            graph: catalogResult.summary,
            mastery,
            assessments,
            recommendations,
        };
    }
}

async function readRecommendations(
    reader: ProgressServiceDependencies["recommendationReader"],
): Promise<ProgressSnapshot["recommendations"]> {
    if (!reader) return [];
    try {
        return (await reader.getSnapshot()).primary.map((item) => ({
            id: item.id,
            kind: item.kind,
            label: item.label,
            targetConceptIds: [...item.targetConceptIds],
            sourceChunkIds: [...item.sourceChunkIds],
            priority: item.priority,
            reasonCodes: [...item.reasonCodes],
            actionState: item.actionState,
            suggestedAction: item.suggestedAction,
            ...(item.suggestedExamMode ? { suggestedExamMode: item.suggestedExamMode } : {}),
        }));
    } catch {
        // 推荐只补充 Dashboard。操作日志损坏时，不得隐藏已经可用的图、掌握度或 Assessment 事实。
        return [];
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

function cloneSnapshot(snapshot: ProgressSnapshot): ProgressSnapshot {
    return {
        ...snapshot,
        graph: { ...snapshot.graph },
        mastery: {
            ...snapshot.mastery,
            levelCounts: { ...snapshot.mastery.levelCounts },
        },
        assessments: { ...snapshot.assessments },
        recommendations: snapshot.recommendations.map((recommendation) => ({
            ...recommendation,
            targetConceptIds: [...recommendation.targetConceptIds],
            sourceChunkIds: [...recommendation.sourceChunkIds],
            reasonCodes: [...recommendation.reasonCodes],
        })),
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
