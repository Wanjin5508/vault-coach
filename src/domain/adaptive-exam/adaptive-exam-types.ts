import type { ExamMode, ExamScopeAnalysisResult, ExamScopeSelection } from "../exam/exam-types";
import type { MasteryLevel } from "../mastery/mastery-types";

/** Why an adaptive plan is being requested. This is independent from ExamMode. */
export type AdaptiveTargetMode = "diagnostic" | "weak-review" | "prerequisite" | "mixed";

export type AdaptiveReasonCode =
    | "unassessed"
    | "low-confidence"
    | "weak-mastery"
    | "developing-mastery"
    | "review-due"
    | "confirmed-prerequisite"
    | "recently-covered"
    | "insufficient-evidence"
    | "scope-capacity-limited";

export type AdaptivePlanIssueCode =
    | "empty-scope"
    | "invalid-question-count"
    | "no-effective-concepts"
    | "no-source-backed-target"
    | "duplicate-target"
    | "out-of-scope-source"
    | "invalid-target-reason"
    | "invalid-target-order"
    | "invalid-target-count";

export interface AdaptivePlanIssue {
    code: AdaptivePlanIssueCode;
    message: string;
    conceptId?: string;
}

/** Revisions used to reject a visible plan that became stale before generation. */
export interface AdaptiveExamRevisions {
    indexRevision: string;
    effectiveGraphRevision: string;
    masteryRevision: string;
    assessmentRevision: string;
}

/** Already-resolved scope facts; the planner never scans the Vault itself. */
export interface AdaptiveExamScopeSnapshot {
    signature: string;
    eligibleChunkIds: readonly string[];
}

/** The smallest Mastery/coverage fact needed to rank a source-backed Concept. */
export interface AdaptivePlanningConcept {
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

/** A confirmed directed prerequisite edge: prerequisite → dependent concept. */
export interface ConfirmedPrerequisite {
    prerequisiteConceptId: string;
    targetConceptId: string;
    relationId: string;
}

export interface AdaptiveExamPlanningInput {
    algorithmVersion: string;
    planningAt: number;
    scope: AdaptiveExamScopeSnapshot;
    examMode: ExamMode;
    targetMode: AdaptiveTargetMode;
    requestedQuestionCount: number;
    revisions: AdaptiveExamRevisions;
    concepts: readonly AdaptivePlanningConcept[];
    confirmedPrerequisites: readonly ConfirmedPrerequisite[];
}

export interface AdaptiveExamTarget {
    conceptId: string;
    label: string;
    sourceChunkIds: readonly string[];
    reasonCodes: readonly AdaptiveReasonCode[];
    priority: number;
    expectedQuestionCount: number;
    prerequisiteOfConceptIds: readonly string[];
}

export interface AdaptiveExamPlanDiagnostics {
    candidateConceptCount: number;
    sourceBackedConceptCount: number;
    excludedConceptIds: readonly string[];
    requestedQuestionCount: number;
    plannedQuestionCount: number;
}

/** A deterministic, disposable plan. It becomes auditable only when copied into a Session. */
export interface AdaptiveExamPlan {
    id: string;
    algorithmVersion: string;
    inputFingerprint: string;
    revisionFingerprint: string;
    planningAt: number;
    examMode: ExamMode;
    targetMode: AdaptiveTargetMode;
    scopeSignature: string;
    revisions: AdaptiveExamRevisions;
    targets: readonly AdaptiveExamTarget[];
    appliedFallbacks: readonly AdaptiveReasonCode[];
    diagnostics: AdaptiveExamPlanDiagnostics;
}

/** Minimum immutable input required by ExamEngine after an adaptive preview is accepted. */
export interface AdaptiveExamGenerationContext {
    planId: string;
    algorithmVersion: string;
    inputFingerprint: string;
    revisionFingerprint: string;
    targetMode: AdaptiveTargetMode;
    examMode: ExamMode;
    scopeSignature: string;
    revisions: AdaptiveExamRevisions;
    targets: readonly AdaptiveExamTarget[];
    appliedFallbacks: readonly AdaptiveReasonCode[];
}

/** Additive Session audit data. It intentionally excludes raw notes and complete Mastery snapshots. */
export interface AdaptivePlanAuditSnapshot {
    planId: string;
    algorithmVersion: string;
    inputFingerprint: string;
    targetMode: AdaptiveTargetMode;
    examMode: ExamMode;
    scopeSignature: string;
    targetConceptIds: string[];
    reasonCodesByConceptId: Record<string, AdaptiveReasonCode[]>;
    appliedFallbacks: AdaptiveReasonCode[];
}

/** Application request assembled from a locked controller analysis result. */
export interface AdaptiveExamPlanRequest {
    selection: ExamScopeSelection;
    analysis: ExamScopeAnalysisResult;
    questionCount: number;
    examMode: ExamMode;
    targetMode: AdaptiveTargetMode;
}

export type AdaptiveExamPlanResult =
    | { status: "ready"; plan: AdaptiveExamPlan }
    | { status: "degraded"; plan: AdaptiveExamPlan; reasonCode: AdaptiveReasonCode }
    | { status: "unavailable"; reasonCode: "no-effective-concepts" | "no-source-backed-target"; message: string };

export function createAdaptiveExamGenerationContext(plan: AdaptiveExamPlan): AdaptiveExamGenerationContext {
    return {
        planId: plan.id,
        algorithmVersion: plan.algorithmVersion,
        inputFingerprint: plan.inputFingerprint,
        revisionFingerprint: plan.revisionFingerprint,
        targetMode: plan.targetMode,
        examMode: plan.examMode,
        scopeSignature: plan.scopeSignature,
        revisions: { ...plan.revisions },
        targets: plan.targets.map((target) => ({
            ...target,
            sourceChunkIds: [...target.sourceChunkIds],
            reasonCodes: [...target.reasonCodes],
            prerequisiteOfConceptIds: [...target.prerequisiteOfConceptIds],
        })),
        appliedFallbacks: [...plan.appliedFallbacks],
    };
}

export function createAdaptivePlanAuditSnapshot(context: AdaptiveExamGenerationContext): AdaptivePlanAuditSnapshot {
    const reasonCodesByConceptId: Record<string, AdaptiveReasonCode[]> = {};
    for (const target of context.targets) {
        reasonCodesByConceptId[target.conceptId] = [...target.reasonCodes];
    }
    return {
        planId: context.planId,
        algorithmVersion: context.algorithmVersion,
        inputFingerprint: context.inputFingerprint,
        targetMode: context.targetMode,
        examMode: context.examMode,
        scopeSignature: context.scopeSignature,
        targetConceptIds: context.targets.map((target) => target.conceptId),
        reasonCodesByConceptId,
        appliedFallbacks: [...context.appliedFallbacks],
    };
}
