import type { AssessmentConceptBinding, AssessmentEvent } from "../assessment/assessment-types";
import type { AssessmentErrorCode, ExamDifficulty } from "../exam/exam-types";
import type { LearningGraphConceptCatalog, LearningGraphConceptCatalogEntry } from "../learning-graph/learning-graph-types";

export const MASTERY_SNAPSHOT_SCHEMA_VERSION = 1 as const;
// v2 为旧版临时 Exam 主题增加精确来源 chunk 记录。
// 现有 v1 快照必须重建，不能作为当前数据展示。
export const MASTERY_ALGORITHM_VERSION = "mastery/v2";

export type MasteryLevel = "unknown" | "weak" | "developing" | "proficient" | "mastered";
export type MasteryTrend = "unknown" | "improving" | "stable" | "declining";
export type MasteryBindingKind = "direct-concept-id" | "exact-display-name" | "exact-alias" | "source-chunk-evidence";
export type MasteryBindingIssueReason = "missing-binding" | "unknown-concept" | "ambiguous-label";

export interface MasteryAlgorithmConfig {
    version: string;
    decayRatePerDay: number;
    difficultyWeights: Record<ExamDifficulty, number>;
    masteredScoreThreshold: number;
    masteredConfidenceThreshold: number;
    trendDeltaThreshold: number;
}

export const DEFAULT_MASTERY_ALGORITHM: MasteryAlgorithmConfig = {
    version: MASTERY_ALGORITHM_VERSION,
    decayRatePerDay: 0.03,
    difficultyWeights: { basic: 0.8, intermediate: 1, advanced: 1.2 },
    masteredScoreThreshold: 0.85,
    masteredConfidenceThreshold: 0.6,
    trendDeltaThreshold: 0.1,
};

/** 一个 Assessment Event 及其 Session JSON 中保存的绑定事实。 */
export interface MasteryAssessmentInput {
    event: AssessmentEvent;
    conceptBindings: readonly AssessmentConceptBinding[];
}

export interface MasteryEvidenceContribution {
    eventId: string;
    sessionId: string;
    questionId: string;
    bindingKind: MasteryBindingKind;
    normalizedScore: number;
    weight: number;
    occurredAt: number;
    difficulty: ExamDifficulty;
    errorCodes: AssessmentErrorCode[];
}

export interface MasteryBindingIssue {
    eventId: string;
    sourceConceptId: string;
    reason: MasteryBindingIssueReason;
    candidateConceptIds?: string[];
}

/**
 * 单个有效 Concept 的可重建掌握度状态。
 * `masteryScore: null` 表示没有足够证据，不能按 0 分展示；所有概率和置信度字段范围为 0 到 1。
 */
export interface ConceptMasteryState {
    conceptId: string;
    masteryScore: number | null;
    confidence: number;
    level: MasteryLevel;
    assessmentCount: number;
    effectiveEvidenceCount: number;
    lastAssessedAt: number | null;
    /** M7 之前不存在人工复核事件，因此该字段必须保持 `null`。 */
    lastReviewedAt: null;
    nextReviewAt: number | null;
    commonErrorCodes: AssessmentErrorCode[];
    trend: MasteryTrend;
    evidence: MasteryEvidenceContribution[];
    calculatedAt: number;
    algorithmVersion: string;
}

/** 可重建本地缓存，不得替代 Assessment Session JSON 事实来源。 */
export interface MasterySnapshotV1 {
    schemaVersion: typeof MASTERY_SNAPSHOT_SCHEMA_VERSION;
    algorithmVersion: string;
    calculatedAt: number;
    states: ConceptMasteryState[];
    sourceEventCount: number;
    unboundIssues: MasteryBindingIssue[];
}

export interface MasteryCalculationInput {
    catalog: LearningGraphConceptCatalog;
    assessments: readonly MasteryAssessmentInput[];
    now: number;
    algorithm?: MasteryAlgorithmConfig;
}

export interface MasteryCalculationResult {
    states: ConceptMasteryState[];
    sourceEventCount: number;
    unboundIssues: MasteryBindingIssue[];
}

/** 全量计算和增量计算共享的确定性中间事实。 */
export interface MasteryAssessmentAnalysis {
    activeAssessments: MasteryAssessmentInput[];
    resolvedEvidence: Array<{
        input: MasteryAssessmentInput;
        conceptId: string;
        bindingKind: MasteryBindingKind;
    }>;
    unboundIssues: MasteryBindingIssue[];
}

/** 应用层可观察的掌握度缓存状态，不包含完整证据明细。 */
export interface MasteryStateView {
    hasSnapshot: boolean;
    dirty: boolean;
    busy: boolean;
    lastError: string | null;
    algorithmVersion: string | null;
    stateCount: number;
    sourceEventCount: number;
    unboundIssueCount: number;
}

/** 可重建掌握度快照的持久化端口；Assessment Session 仍是事实来源。 */
export interface MasteryStore {
    load(): Promise<MasterySnapshotV1 | null>;
    save(snapshot: MasterySnapshotV1): Promise<void>;
    clear(): Promise<void>;
}

/** 掌握度计算对当前有效概念目录的只读端口。 */
export interface MasteryConceptCatalogReader {
    getConceptCatalog(): LearningGraphConceptCatalog;
}

export type MasteryConceptCatalogEntry = LearningGraphConceptCatalogEntry;
