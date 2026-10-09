import type { ExamMode, ExamScopeAnalysisResult, ExamScopeSelection } from "../exam/exam-types";
import type { MasteryLevel } from "../mastery/mastery-types";

/** 请求自适应方案的原因；该语义与 `ExamMode` 相互独立。 */
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

/** 用于拒绝在生成前已经过期的可见方案的版本集合。 */
export interface AdaptiveExamRevisions {
    indexRevision: string;
    effectiveGraphRevision: string;
    masteryRevision: string;
    assessmentRevision: string;
}

/** 已解析的范围事实；规划器本身不得扫描 Vault。 */
export interface AdaptiveExamScopeSnapshot {
    signature: string;
    eligibleChunkIds: readonly string[];
}

/** 对有来源 Concept 排序所需的最小 Mastery/覆盖率事实。 */
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

/** 已确认的有向先修边：先修概念 → 依赖概念。 */
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

/** 确定性、可重建的方案；只有复制到 Session 后才成为可审计记录。 */
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

/** 用户接受自适应预览后，`ExamEngine` 所需的最小不可变输入。 */
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

/** 追加到 Session 的审计数据；不得包含笔记原文或完整 Mastery 快照。 */
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

/** 根据 Controller 已锁定的分析结果组装的应用层请求。 */
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

/** 将规划结果复制为生成阶段的不可变输入，防止后续状态变化改写本次考试目标。 */
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

/** 提取随考试记录持久化的最小计划审计信息，不包含可重建的排序分数。 */
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
