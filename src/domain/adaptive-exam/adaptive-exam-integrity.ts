import type {
    AdaptiveExamPlan,
    AdaptiveExamPlanningInput,
    AdaptivePlanIssue,
    AdaptiveReasonCode,
} from "./adaptive-exam-types";

const VALID_REASONS: ReadonlySet<AdaptiveReasonCode> = new Set<AdaptiveReasonCode>([
    "unassessed",
    "low-confidence",
    "weak-mastery",
    "developing-mastery",
    "review-due",
    "confirmed-prerequisite",
    "recently-covered",
    "insufficient-evidence",
    "scope-capacity-limited",
]);

export function validateAdaptiveExamPlanningInput(input: AdaptiveExamPlanningInput): AdaptivePlanIssue[] {
    const issues: AdaptivePlanIssue[] = [];
    if (input.scope.eligibleChunkIds.length === 0) {
        issues.push({ code: "empty-scope", message: "Adaptive exam scope has no eligible chunks." });
    }
    if (!Number.isFinite(input.requestedQuestionCount) || input.requestedQuestionCount < 1) {
        issues.push({ code: "invalid-question-count", message: "Requested question count must be positive." });
    }
    if (input.concepts.length === 0) {
        issues.push({ code: "no-effective-concepts", message: "No effective Concepts are available for planning." });
    }
    return issues;
}

export function validateAdaptiveExamPlan(plan: AdaptiveExamPlan): AdaptivePlanIssue[] {
    const issues: AdaptivePlanIssue[] = [];
    const targetIds = new Set<string>();
    let previousPriority = Number.POSITIVE_INFINITY;
    let previousId = "";
    let plannedQuestionCount = 0;
    for (const target of plan.targets) {
        if (targetIds.has(target.conceptId)) {
            issues.push({ code: "duplicate-target", message: "Plan contains duplicate targets.", conceptId: target.conceptId });
        }
        targetIds.add(target.conceptId);
        if (target.sourceChunkIds.length === 0) {
            issues.push({ code: "no-source-backed-target", message: "Plan target has no source chunks.", conceptId: target.conceptId });
        }
        if (target.sourceChunkIds.some((chunkId) => chunkId.trim().length === 0)) {
            issues.push({ code: "out-of-scope-source", message: "Plan target contains an invalid source chunk.", conceptId: target.conceptId });
        }
        if (target.expectedQuestionCount < 1) {
            issues.push({ code: "invalid-target-count", message: "Plan target has an invalid question count.", conceptId: target.conceptId });
        }
        if (target.reasonCodes.some((reason) => !VALID_REASONS.has(reason))) {
            issues.push({ code: "invalid-target-reason", message: "Plan target has an invalid reason code.", conceptId: target.conceptId });
        }
        if (target.priority > previousPriority || (target.priority === previousPriority && target.conceptId.localeCompare(previousId) < 0)) {
            issues.push({ code: "invalid-target-order", message: "Plan targets are not stably ordered.", conceptId: target.conceptId });
        }
        previousPriority = target.priority;
        previousId = target.conceptId;
        plannedQuestionCount += target.expectedQuestionCount;
    }
    if (plannedQuestionCount !== plan.diagnostics.plannedQuestionCount
        || plannedQuestionCount > plan.diagnostics.requestedQuestionCount) {
        issues.push({ code: "invalid-target-count", message: "Plan question allocation does not match its diagnostics." });
    }
    return issues;
}
