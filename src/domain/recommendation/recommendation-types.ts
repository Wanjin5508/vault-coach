/**
 * 学习建议规划、展示和用户操作日志的领域契约。
 *
 * `Recommendation` 是可重建的派生结果；只有 `ReviewActionEvent` 进入持久化事实。
 * 算法版本变化后应重新生成建议，不能把旧建议快照当作用户事实迁移。
 */
import type { ExamMode } from "../exam/exam-types";
import type { MasteryLevel } from "../mastery/mastery-types";

export const REVIEW_ACTIONS_SCHEMA_VERSION = 1 as const;
export type RecommendationKind = "review-concept" | "review-prerequisite" | "practice-topic" | "explore-gap";
export type RecommendationReasonCode = "weak-mastery" | "developing-mastery" | "review-due" | "low-confidence" | "unassessed" | "confirmed-prerequisite" | "high-connectivity" | "recently-covered";
export type SuggestedAction = "review-source" | "practice-exam";
export type ReviewAction = "dismissed" | "deferred" | "completed" | "restored";
export type RecommendationActionState = "open" | "dismissed" | "deferred" | "completed";

/** 用户对一条建议执行的只追加审计事件。 */
export interface ReviewActionEvent {
    id: string;
    recommendationId: string;
    action: ReviewAction;
    occurredAt: number;
    deferUntil?: number;
    note?: string;
}

export interface ReviewActionsDocumentV1 {
    schemaVersion: typeof REVIEW_ACTIONS_SCHEMA_VERSION;
    events: ReviewActionEvent[];
}

export interface RecommendationPlanningConcept {
    id: string;
    label: string;
    sourceChunkIds: readonly string[];
    masteryScore: number | null;
    confidence: number;
    level: MasteryLevel;
    assessmentCount: number;
    lastAssessedAt: number | null;
    nextReviewAt: number | null;
}

export interface RecommendationPrerequisite {
    prerequisiteConceptId: string;
    targetConceptId: string;
    relationId: string;
}

export interface RecommendationPlanningInput {
    algorithmVersion: string;
    generatedAt: number;
    concepts: readonly RecommendationPlanningConcept[];
    prerequisites: readonly RecommendationPrerequisite[];
    actionEvents: readonly ReviewActionEvent[];
}

/** 一次规划生成的临时建议；优先级只在同一算法版本内具有可比性。 */
export interface Recommendation {
    id: string;
    kind: RecommendationKind;
    label: string;
    targetConceptIds: readonly string[];
    sourceChunkIds: readonly string[];
    priority: number;
    reasonCodes: readonly RecommendationReasonCode[];
    masteryScore: number | null;
    confidence: number;
    lastAssessedAt: number | null;
    nextReviewAt: number | null;
    suggestedAction: SuggestedAction;
    suggestedExamMode?: ExamMode;
    actionState: RecommendationActionState;
}

/** 同一算法版本在一个生成时刻产生的完整建议队列。 */
export interface RecommendationSnapshot {
    algorithmVersion: string;
    generatedAt: number;
    primary: readonly Recommendation[];
    queue: readonly Recommendation[];
}

/** 用户建议操作日志的持久化端口；实现不得覆盖或压缩既有事件。 */
export interface ReviewActionStore {
    list(): Promise<ReviewActionEvent[]>;
    append(event: ReviewActionEvent): Promise<void>;
}
