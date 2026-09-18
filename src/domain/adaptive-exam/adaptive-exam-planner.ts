import { createAdaptivePlanInputFingerprint, createAdaptiveRevisionFingerprint } from "./adaptive-exam-fingerprint";
import { validateAdaptiveExamPlanningInput } from "./adaptive-exam-integrity";
import { ADAPTIVE_EXAM_POLICY } from "./adaptive-exam-policy";
import type {
    AdaptiveExamPlan,
    AdaptiveExamPlanningInput,
    AdaptiveExamTarget,
    AdaptivePlanningConcept,
    AdaptiveReasonCode,
    ConfirmedPrerequisite,
} from "./adaptive-exam-types";

interface RankedConcept {
    concept: AdaptivePlanningConcept;
    sourceChunkIds: string[];
    reasonCodes: AdaptiveReasonCode[];
    priority: number;
    prerequisiteOfConceptIds: string[];
}

/**
 * Pure, deterministic target selection. It does not access time, storage,
 * models, graph services, or DOM; callers must provide every planning fact.
 */
export function buildAdaptiveExamPlan(input: AdaptiveExamPlanningInput): AdaptiveExamPlan {
    const issues = validateAdaptiveExamPlanningInput(input);
    if (issues.length > 0) {
        throw new Error(`Adaptive exam input is invalid: ${issues.map((issue) => issue.code).join(", ")}`);
    }

    const scopeChunkIds = new Set(input.scope.eligibleChunkIds);
    const sourceBacked = input.concepts
        .map((concept) => ({
            concept,
            sourceChunkIds: normalizeSourceChunkIds(concept.sourceChunkIds, scopeChunkIds),
        }))
        .filter((item) => item.sourceChunkIds.length > 0)
        .sort((left, right) => left.concept.id.localeCompare(right.concept.id));
    const excludedConceptIds = input.concepts
        .filter((concept) => !sourceBacked.some((item) => item.concept.id === concept.id))
        .map((concept) => concept.id)
        .sort((left, right) => left.localeCompare(right));
    const appliedFallbacks: AdaptiveReasonCode[] = [];
    const targetLimit = Math.min(ADAPTIVE_EXAM_POLICY.maxQuestionCount, Math.max(1, Math.floor(input.requestedQuestionCount)));
    let ranked = rankForMode(sourceBacked, input, appliedFallbacks);
    if (ranked.length === 0 && sourceBacked.length > 0) {
        ranked = rankDiagnostic(sourceBacked, input.planningAt);
        appliedFallbacks.push("insufficient-evidence");
    }

    const selected = ranked.slice(0, Math.min(targetLimit, ranked.length));
    const targets = allocateQuestionCounts(selected, targetLimit);
    const plannedQuestionCount = targets.reduce((total, target) => total + target.expectedQuestionCount, 0);
    if (plannedQuestionCount < targetLimit) appliedFallbacks.push("scope-capacity-limited");
    const inputFingerprint = createAdaptivePlanInputFingerprint(input);
    const revisionFingerprint = createAdaptiveRevisionFingerprint(input.scope.signature, input.revisions);

    return {
        id: `adaptive-exam:${inputFingerprint}`,
        algorithmVersion: input.algorithmVersion,
        inputFingerprint,
        revisionFingerprint,
        planningAt: input.planningAt,
        examMode: input.examMode,
        targetMode: input.targetMode,
        scopeSignature: input.scope.signature,
        revisions: { ...input.revisions },
        targets,
        appliedFallbacks: Array.from(new Set(appliedFallbacks)),
        diagnostics: {
            candidateConceptCount: input.concepts.length,
            sourceBackedConceptCount: sourceBacked.length,
            excludedConceptIds,
            requestedQuestionCount: targetLimit,
            plannedQuestionCount,
        },
    };
}

function rankForMode(
    sourceBacked: ReadonlyArray<{ concept: AdaptivePlanningConcept; sourceChunkIds: string[] }>,
    input: AdaptiveExamPlanningInput,
    appliedFallbacks: AdaptiveReasonCode[],
): RankedConcept[] {
    switch (input.targetMode) {
        case "weak-review": {
            const ranked = rankWeakReview(sourceBacked, input.planningAt);
            if (ranked.length > 0) return ranked;
            appliedFallbacks.push("insufficient-evidence");
            return rankDiagnostic(sourceBacked, input.planningAt);
        }
        case "prerequisite": {
            const ranked = rankPrerequisites(sourceBacked, input.confirmedPrerequisites, input.planningAt);
            if (ranked.length > 0) return ranked;
            appliedFallbacks.push("insufficient-evidence");
            return rankDiagnostic(sourceBacked, input.planningAt);
        }
        case "mixed":
            return rankMixed(sourceBacked, input.confirmedPrerequisites, input.planningAt);
        case "diagnostic":
        default:
            return rankDiagnostic(sourceBacked, input.planningAt);
    }
}

function rankDiagnostic(
    sourceBacked: ReadonlyArray<{ concept: AdaptivePlanningConcept; sourceChunkIds: string[] }>,
    planningAt: number,
): RankedConcept[] {
    return sortRanked(sourceBacked.map(({ concept, sourceChunkIds }) => {
        const reasonCodes: AdaptiveReasonCode[] = [];
        let priority = 0;
        if (concept.assessmentCount === 0) {
            reasonCodes.push("unassessed");
            priority += ADAPTIVE_EXAM_POLICY.reasonTiers.unassessed;
        }
        if (concept.confidence < ADAPTIVE_EXAM_POLICY.lowConfidenceThreshold) {
            reasonCodes.push("low-confidence");
            priority += ADAPTIVE_EXAM_POLICY.reasonTiers.lowConfidence;
        }
        if (reasonCodes.length === 0) {
            reasonCodes.push("recently-covered");
            priority += ADAPTIVE_EXAM_POLICY.reasonTiers.recentlyCovered;
        }
        return createRankedConcept(concept, sourceChunkIds, reasonCodes, priority, planningAt, []);
    }));
}

function rankWeakReview(
    sourceBacked: ReadonlyArray<{ concept: AdaptivePlanningConcept; sourceChunkIds: string[] }>,
    planningAt: number,
): RankedConcept[] {
    const ranked = sourceBacked.flatMap(({ concept, sourceChunkIds }) => {
        const reasonCodes: AdaptiveReasonCode[] = [];
        let priority = 0;
        if (concept.level === "weak") {
            reasonCodes.push("weak-mastery");
            priority += ADAPTIVE_EXAM_POLICY.reasonTiers.weakMastery;
        } else if (concept.level === "developing") {
            reasonCodes.push("developing-mastery");
            priority += ADAPTIVE_EXAM_POLICY.reasonTiers.developingMastery;
        }
        if (concept.nextReviewAt !== null && concept.nextReviewAt <= planningAt) {
            reasonCodes.push("review-due");
            priority += ADAPTIVE_EXAM_POLICY.reasonTiers.reviewDue;
        }
        if (concept.confidence < ADAPTIVE_EXAM_POLICY.lowConfidenceThreshold) {
            reasonCodes.push("low-confidence");
            priority += ADAPTIVE_EXAM_POLICY.reasonTiers.lowConfidence;
        }
        return reasonCodes.length === 0
            ? []
            : [createRankedConcept(concept, sourceChunkIds, reasonCodes, priority, planningAt, [])];
    });
    return sortRanked(ranked);
}

function rankPrerequisites(
    sourceBacked: ReadonlyArray<{ concept: AdaptivePlanningConcept; sourceChunkIds: string[] }>,
    relations: readonly ConfirmedPrerequisite[],
    planningAt: number,
): RankedConcept[] {
    const byId = new Map(sourceBacked.map((item) => [item.concept.id, item]));
    const dependentIds = new Set(rankWeakReview(sourceBacked, planningAt).map((item) => item.concept.id));
    if (dependentIds.size === 0) {
        for (const item of rankDiagnostic(sourceBacked, planningAt)) dependentIds.add(item.concept.id);
    }
    const prerequisiteOf = new Map<string, string[]>();
    for (const relation of relations) {
        if (!dependentIds.has(relation.targetConceptId)) continue;
        if (!byId.has(relation.prerequisiteConceptId)) continue;
        const targets = prerequisiteOf.get(relation.prerequisiteConceptId) ?? [];
        targets.push(relation.targetConceptId);
        prerequisiteOf.set(relation.prerequisiteConceptId, targets);
    }
    const ranked = Array.from(prerequisiteOf.entries()).flatMap(([conceptId, dependentConceptIds]) => {
        const item = byId.get(conceptId);
        if (!item) return [];
        return [createRankedConcept(
            item.concept,
            item.sourceChunkIds,
            ["confirmed-prerequisite"],
            ADAPTIVE_EXAM_POLICY.reasonTiers.confirmedPrerequisite,
            planningAt,
            Array.from(new Set(dependentConceptIds)).sort((left, right) => left.localeCompare(right)),
        )];
    });
    return sortRanked(ranked);
}

function rankMixed(
    sourceBacked: ReadonlyArray<{ concept: AdaptivePlanningConcept; sourceChunkIds: string[] }>,
    relations: readonly ConfirmedPrerequisite[],
    planningAt: number,
): RankedConcept[] {
    const merged = new Map<string, RankedConcept>();
    for (const candidate of [
        ...rankDiagnostic(sourceBacked, planningAt),
        ...rankWeakReview(sourceBacked, planningAt),
        ...rankPrerequisites(sourceBacked, relations, planningAt),
    ]) {
        const existing = merged.get(candidate.concept.id);
        if (!existing) {
            merged.set(candidate.concept.id, candidate);
            continue;
        }
        merged.set(candidate.concept.id, {
            ...existing,
            reasonCodes: Array.from(new Set([...existing.reasonCodes, ...candidate.reasonCodes])),
            priority: Math.max(existing.priority, candidate.priority),
            prerequisiteOfConceptIds: Array.from(new Set([
                ...existing.prerequisiteOfConceptIds,
                ...candidate.prerequisiteOfConceptIds,
            ])).sort((left, right) => left.localeCompare(right)),
        });
    }
    return sortRanked(Array.from(merged.values()));
}

function createRankedConcept(
    concept: AdaptivePlanningConcept,
    sourceChunkIds: string[],
    reasonCodes: AdaptiveReasonCode[],
    basePriority: number,
    planningAt: number,
    prerequisiteOfConceptIds: string[],
): RankedConcept {
    const daysSinceAssessment = concept.lastAssessedAt === null
        ? 365
        : Math.max(0, Math.floor((planningAt - concept.lastAssessedAt) / (24 * 60 * 60 * 1000)));
    const confidencePenalty = Math.max(0, Math.min(100, Math.round((1 - concept.confidence) * 100)));
    const cooling = concept.lastAssessedAt !== null && planningAt - concept.lastAssessedAt < ADAPTIVE_EXAM_POLICY.cooldownMs;
    const normalizedReasons = cooling && !reasonCodes.includes("recently-covered")
        ? [...reasonCodes, "recently-covered" as const]
        : reasonCodes;
    return {
        concept,
        sourceChunkIds,
        reasonCodes: normalizedReasons,
        priority: basePriority + Math.min(99, daysSinceAssessment) + confidencePenalty - (cooling ? 60 : 0),
        prerequisiteOfConceptIds,
    };
}

function sortRanked(items: readonly RankedConcept[]): RankedConcept[] {
    return [...items].sort((left, right) => right.priority - left.priority
        || compareNullableNumber(left.concept.lastAssessedAt, right.concept.lastAssessedAt)
        || left.concept.id.localeCompare(right.concept.id));
}

function allocateQuestionCounts(items: readonly RankedConcept[], requestedQuestionCount: number): AdaptiveExamTarget[] {
    if (items.length === 0) return [];
    const allocated = items.map((item) => ({
        ...item,
        expectedQuestionCount: 1,
        capacity: Math.max(1, Math.ceil(item.sourceChunkIds.length / 2)),
    }));
    let remainingQuestionCount = Math.max(0, requestedQuestionCount - allocated.length);
    let cursor = 0;
    while (remainingQuestionCount > 0) {
        const target = allocated[cursor % allocated.length];
        cursor += 1;
        if (!target) break;
        if (target.expectedQuestionCount >= target.capacity) {
            if (allocated.every((item) => item.expectedQuestionCount >= item.capacity)) break;
            continue;
        }
        target.expectedQuestionCount += 1;
        remainingQuestionCount -= 1;
    }
    return allocated.map((item) => ({
        conceptId: item.concept.id,
        label: item.concept.label,
        sourceChunkIds: [...item.sourceChunkIds],
        reasonCodes: [...item.reasonCodes],
        priority: item.priority,
        expectedQuestionCount: item.expectedQuestionCount,
        prerequisiteOfConceptIds: [...item.prerequisiteOfConceptIds],
    }));
}

function normalizeSourceChunkIds(sourceChunkIds: readonly string[], scopeChunkIds: ReadonlySet<string>): string[] {
    return Array.from(new Set(sourceChunkIds.filter((chunkId) => scopeChunkIds.has(chunkId))))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, ADAPTIVE_EXAM_POLICY.maxSourceChunksPerTarget);
}

function compareNullableNumber(left: number | null, right: number | null): number {
    const normalizedLeft = left ?? Number.NEGATIVE_INFINITY;
    const normalizedRight = right ?? Number.NEGATIVE_INFINITY;
    return normalizedLeft - normalizedRight;
}
