import type { MasteryLevel } from "../../domain/mastery/mastery-types";

export const PROGRESS_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type ProgressGraphStatus = "ready" | "unavailable";
export type ProgressMasteryStatus = "current" | "stale" | "missing" | "calculating" | "unavailable";
export type ProgressAssessmentStatus = "ready" | "unavailable";

/**
 * Read-only summary of the effective Concept catalog. It deliberately contains
 * no renderer projection or graph-store facts, so a Dashboard cannot bypass
 * the Learning Graph query boundary.
 */
export interface ProgressGraphSummary {
    status: ProgressGraphStatus;
    conceptCount: number;
    message: string | null;
}

/**
 * A bounded, display-ready aggregation of a rebuildable Mastery snapshot.
 * coverageRatio remains null when a current effective catalog or Mastery
 * snapshot is unavailable; zero must not be used to fabricate a conclusion.
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

/** Summary based only on structured Assessment Session history. */
export interface ProgressAssessmentSummary {
    status: ProgressAssessmentStatus;
    message: string | null;
    sessionCount: number;
    scoredSessionCount: number;
    latestSessionAt: number | null;
}

/**
 * Reserved stable display contract for M7. L5.1 intentionally returns an
 * empty list because no RecommendationService exists yet.
 */
export interface ProgressRecommendationPreview {
    id: string;
    kind: "review-concept" | "review-prerequisite" | "practice-topic" | "explore-gap";
    label: string;
    explanation: string;
    targetConceptIds: readonly string[];
}

/**
 * Cache freshness for the disposable Progress read model. This is separate
 * from Mastery freshness because an index, graph, or Assessment event can
 * invalidate the composed snapshot before it is read again.
 */
export interface ProgressStateView {
    hasSnapshot: boolean;
    dirty: boolean;
    busy: boolean;
    lastError: string | null;
    generatedAt: number | null;
}

/**
 * One disposable read model for the future Progress Dashboard / Learning Map.
 * It is never persisted and cannot mutate a graph, mastery state, assessment,
 * or recommendation decision.
 */
export interface ProgressSnapshot {
    schemaVersion: typeof PROGRESS_SNAPSHOT_SCHEMA_VERSION;
    generatedAt: number;
    graph: ProgressGraphSummary;
    mastery: ProgressMasterySummary;
    assessments: ProgressAssessmentSummary;
    recommendations: readonly ProgressRecommendationPreview[];
}
