import type { MasteryLevel } from "../../domain/mastery/mastery-types";
import type {
    RecommendationActionState,
    RecommendationKind,
    RecommendationReasonCode,
    SuggestedAction,
} from "../../domain/recommendation/recommendation-types";
import type { ExamMode } from "../../domain/exam/exam-types";

export const PROGRESS_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type ProgressGraphStatus = "ready" | "unavailable";
export type ProgressMasteryStatus = "current" | "stale" | "missing" | "calculating" | "unavailable";
export type ProgressAssessmentStatus = "ready" | "unavailable";

/**
 * 有效 Concept 目录的只读摘要。
 *
 * 其中不包含渲染投影或图存储事实，防止 Dashboard 绕过 Learning Graph 查询边界。
 */
export interface ProgressGraphSummary {
    status: ProgressGraphStatus;
    conceptCount: number;
    message: string | null;
}

/**
 * 从可重建 Mastery 快照生成的有界、可直接展示的聚合结果。
 *
 * 当前有效目录或 Mastery 快照不可用时，`coverageRatio` 必须保持 `null`；
 * 不得用 0 伪造负面结论。
 */
export interface ProgressMasterySummary {
    status: ProgressMasteryStatus;
    message: string | null;
    conceptCount: number;
    assessedConceptCount: number;
    coverageRatio: number | null;
    levelCounts: Readonly<Record<MasteryLevel, number>>;
    snapshotCalculatedAt: number | null;
    algorithmVersion: string | null;
    sourceEventCount: number;
    unboundIssueCount: number;
}

/** 仅根据结构化 Assessment Session 历史生成的摘要。 */
export interface ProgressAssessmentSummary {
    status: ProgressAssessmentStatus;
    message: string | null;
    sessionCount: number;
    scoredSessionCount: number;
    latestSessionAt: number | null;
}

/** 独立可重建推荐的有界展示投影。 */
export interface ProgressRecommendationPreview {
    id: string;
    kind: RecommendationKind;
    label: string;
    targetConceptIds: readonly string[];
    sourceChunkIds: readonly string[];
    priority: number;
    reasonCodes: readonly RecommendationReasonCode[];
    actionState: RecommendationActionState;
    suggestedAction: SuggestedAction;
    suggestedExamMode?: ExamMode;
}

/**
 * 可重建 Progress 只读模型的缓存新鲜度。
 *
 * 该状态与 Mastery 新鲜度分开管理，因为索引、图或 Assessment 事件都可能在下次读取前
 * 使组合快照失效。
 */
export interface ProgressStateView {
    hasSnapshot: boolean;
    dirty: boolean;
    busy: boolean;
    lastError: string | null;
    generatedAt: number | null;
}

/**
 * 供 Progress Dashboard 和 Learning Map 使用的可重建只读模型。
 *
 * 该对象不持久化，也不能修改图、掌握度状态、Assessment 或推荐决策。
 */
export interface ProgressSnapshot {
    schemaVersion: typeof PROGRESS_SNAPSHOT_SCHEMA_VERSION;
    generatedAt: number;
    graph: ProgressGraphSummary;
    mastery: ProgressMasterySummary;
    assessments: ProgressAssessmentSummary;
    recommendations: readonly ProgressRecommendationPreview[];
}
