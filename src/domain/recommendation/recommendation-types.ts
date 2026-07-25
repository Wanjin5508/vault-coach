import type { ExamMode } from "../exam/exam-types";
import type { MasteryLevel } from "../mastery/mastery-types";

export const REVIEW_ACTIONS_SCHEMA_VERSION = 1 as const;
export type RecommendationKind = "review-concept" | "review-prerequisite" | "practice-topic" | "explore-gap";
export type RecommendationReasonCode = "weak-mastery" | "developing-mastery" | "review-due" | "low-confidence" | "unassessed" | "confirmed-prerequisite" | "high-connectivity" | "recently-covered";
export type SuggestedAction = "review-source" | "practice-exam";
export type ReviewAction = "dismissed" | "deferred" | "completed" | "restored";
export type RecommendationActionState = "open" | "dismissed" | "deferred" | "completed";

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

export interface RecommendationSnapshot {
    algorithmVersion: string;
    generatedAt: number;
    primary: readonly Recommendation[];
    queue: readonly Recommendation[];
}

export interface ReviewActionStore {
    list(): Promise<ReviewActionEvent[]>;
    append(event: ReviewActionEvent): Promise<void>;
}
