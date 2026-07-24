import type { AssessmentConceptBinding, AssessmentEvent } from "../assessment/assessment-types";
import type { AssessmentErrorCode, ExamDifficulty } from "../exam/exam-types";
import type { LearningGraphConceptCatalog, LearningGraphConceptCatalogEntry } from "../learning-graph/learning-graph-types";

export const MASTERY_SNAPSHOT_SCHEMA_VERSION = 1 as const;
// v2 adds exact source-chunk provenance for legacy provisional Exam topics.
// Existing v1 snapshots must be rebuilt instead of being shown as current.
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

/** One Assessment Event plus the binding facts stored in its Session JSON. */
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

export interface ConceptMasteryState {
    conceptId: string;
    masteryScore: number | null;
    confidence: number;
    level: MasteryLevel;
    assessmentCount: number;
    effectiveEvidenceCount: number;
    lastAssessedAt: number | null;
    /** No manual-review event exists before M7, so this must remain null. */
    lastReviewedAt: null;
    nextReviewAt: number | null;
    commonErrorCodes: AssessmentErrorCode[];
    trend: MasteryTrend;
    evidence: MasteryEvidenceContribution[];
    calculatedAt: number;
    algorithmVersion: string;
}

/** Rebuildable local cache, never a replacement for Assessment Session JSON. */
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

/** Intermediate deterministic facts shared by a full and an incremental calculation. */
export interface MasteryAssessmentAnalysis {
    activeAssessments: MasteryAssessmentInput[];
    resolvedEvidence: Array<{
        input: MasteryAssessmentInput;
        conceptId: string;
        bindingKind: MasteryBindingKind;
    }>;
    unboundIssues: MasteryBindingIssue[];
}

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

export interface MasteryStore {
    load(): Promise<MasterySnapshotV1 | null>;
    save(snapshot: MasterySnapshotV1): Promise<void>;
    clear(): Promise<void>;
}

export interface MasteryConceptCatalogReader {
    getConceptCatalog(): LearningGraphConceptCatalog;
}

export type MasteryConceptCatalogEntry = LearningGraphConceptCatalogEntry;
