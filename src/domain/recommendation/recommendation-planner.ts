import { RECOMMENDATION_POLICY } from "./recommendation-policy";
import type { Recommendation, RecommendationActionState, RecommendationKind, RecommendationPlanningConcept, RecommendationPlanningInput, RecommendationReasonCode } from "./recommendation-types";

/** Pure, stable recommendation ranking. It has no storage, model, or UI dependency. */
export function buildRecommendations(input: RecommendationPlanningInput): Recommendation[] {
    const concepts = input.concepts
        .map((concept) => ({ ...concept, sourceChunkIds: normalizeChunks(concept.sourceChunkIds) }))
        .filter((concept) => concept.sourceChunkIds.length > 0)
        .sort((left, right) => left.id.localeCompare(right.id));
    const byId = new Map(concepts.map((concept) => [concept.id, concept]));
    const importanceById = buildLocalImportance(input.prerequisites, byId);
    const actions = resolveActionStates(input.actionEvents, input.generatedAt);
    const recommendations = concepts.flatMap((concept) => createConceptRecommendation(
        concept,
        input.generatedAt,
        actions.get(`recommendation:concept:${concept.id}`) ?? "open",
        importanceById.get(concept.id) ?? 0,
    ));
    const weakTargetIds = new Set(concepts.filter((concept) => concept.level === "weak" || concept.level === "developing").map((concept) => concept.id));
    const emittedPrerequisitePairs = new Set<string>();
    for (const relation of [...input.prerequisites].sort((left, right) => left.relationId.localeCompare(right.relationId))) {
        if (!weakTargetIds.has(relation.targetConceptId)) continue;
        const concept = byId.get(relation.prerequisiteConceptId);
        if (!concept) continue;
        const pairKey = `${concept.id}\u0000${relation.targetConceptId}`;
        if (emittedPrerequisitePairs.has(pairKey)) continue;
        emittedPrerequisitePairs.add(pairKey);
        recommendations.push(createPrerequisiteRecommendation(
            concept,
            relation.targetConceptId,
            actions.get(`recommendation:prerequisite:${concept.id}:${relation.targetConceptId}`) ?? "open",
            importanceById.get(concept.id) ?? 0,
        ));
    }
    return recommendations.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

function createConceptRecommendation(
    concept: RecommendationPlanningConcept,
    now: number,
    actionState: RecommendationActionState,
    localImportance: number,
): Recommendation[] {
    const reasons: RecommendationReasonCode[] = [];
    let priority = 0;
    if (concept.level === "weak") { reasons.push("weak-mastery"); priority += RECOMMENDATION_POLICY.tiers.weakMastery; }
    else if (concept.level === "developing") { reasons.push("developing-mastery"); priority += RECOMMENDATION_POLICY.tiers.developingMastery; }
    if (concept.nextReviewAt !== null && concept.nextReviewAt <= now) { reasons.push("review-due"); priority += RECOMMENDATION_POLICY.tiers.reviewDue; }
    if (concept.assessmentCount === 0) { reasons.push("unassessed"); priority += RECOMMENDATION_POLICY.tiers.unassessed; }
    if (concept.confidence < RECOMMENDATION_POLICY.lowConfidenceThreshold) { reasons.push("low-confidence"); priority += RECOMMENDATION_POLICY.tiers.lowConfidence; }
    if (localImportance > 0) {
        reasons.push("high-connectivity");
        priority += importanceBonus(localImportance);
    }
    if (reasons.length === 0) return [];
    if (concept.lastAssessedAt !== null && now - concept.lastAssessedAt < RECOMMENDATION_POLICY.recentAssessmentMs) {
        reasons.push("recently-covered");
        priority -= RECOMMENDATION_POLICY.tiers.recentlyCoveredPenalty;
    }
    const kind: RecommendationKind = reasons.includes("weak-mastery") || reasons.includes("developing-mastery") || reasons.includes("review-due")
        ? "review-concept" : reasons.includes("unassessed") ? "explore-gap" : "practice-topic";
    return [{
        id: `recommendation:concept:${concept.id}`,
        kind,
        label: concept.label,
        targetConceptIds: [concept.id],
        sourceChunkIds: concept.sourceChunkIds,
        priority,
        reasonCodes: reasons,
        masteryScore: concept.masteryScore,
        confidence: concept.confidence,
        lastAssessedAt: concept.lastAssessedAt,
        nextReviewAt: concept.nextReviewAt,
        suggestedAction: kind === "explore-gap" ? "review-source" : "practice-exam",
        suggestedExamMode: kind === "practice-topic" ? "challenge" : "simple",
        actionState,
    }];
}

function createPrerequisiteRecommendation(
    concept: RecommendationPlanningConcept,
    dependentId: string,
    actionState: RecommendationActionState,
    localImportance: number,
): Recommendation {
    return {
        id: `recommendation:prerequisite:${concept.id}:${dependentId}`,
        kind: "review-prerequisite",
        label: concept.label,
        targetConceptIds: [concept.id, dependentId],
        sourceChunkIds: concept.sourceChunkIds,
        priority: RECOMMENDATION_POLICY.tiers.confirmedPrerequisite + importanceBonus(localImportance) + Math.round((1 - concept.confidence) * 100),
        reasonCodes: localImportance > 0 ? ["confirmed-prerequisite", "high-connectivity"] : ["confirmed-prerequisite"],
        masteryScore: concept.masteryScore,
        confidence: concept.confidence,
        lastAssessedAt: concept.lastAssessedAt,
        nextReviewAt: concept.nextReviewAt,
        suggestedAction: "practice-exam",
        suggestedExamMode: "simple",
        actionState,
    };
}

/**
 * Local importance counts only confirmed prerequisite endpoints. It is a
 * bounded domain fact, not a renderer node size, force-layout position, or
 * embedding similarity. The per-relation bonus is capped in policy.
 */
function buildLocalImportance(
    relations: readonly import("./recommendation-types").RecommendationPrerequisite[],
    concepts: ReadonlyMap<string, RecommendationPlanningConcept>,
): Map<string, number> {
    const importance = new Map<string, number>();
    for (const relation of relations) {
        if (concepts.has(relation.prerequisiteConceptId)) {
            importance.set(relation.prerequisiteConceptId, (importance.get(relation.prerequisiteConceptId) ?? 0) + 1);
        }
        if (concepts.has(relation.targetConceptId)) {
            importance.set(relation.targetConceptId, (importance.get(relation.targetConceptId) ?? 0) + 1);
        }
    }
    return importance;
}

function importanceBonus(localImportance: number): number {
    return Math.min(
        RECOMMENDATION_POLICY.tiers.maxImportanceBonus,
        Math.max(0, Math.floor(localImportance)) * RECOMMENDATION_POLICY.tiers.importancePerRelation,
    );
}

function resolveActionStates(events: readonly import("./recommendation-types").ReviewActionEvent[], now: number): Map<string, RecommendationActionState> {
    const latest = new Map<string, import("./recommendation-types").ReviewActionEvent>();
    for (const event of [...events].sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))) latest.set(event.recommendationId, event);
    return new Map(Array.from(latest.entries()).map(([id, event]) => [id, getActionState(event, now)]));
}

function getActionState(
    event: import("./recommendation-types").ReviewActionEvent,
    now: number,
): RecommendationActionState {
    switch (event.action) {
        case "restored":
            return "open";
        case "deferred":
            // A missing date intentionally means "snooze until I restore it".
            return event.deferUntil !== undefined && event.deferUntil <= now ? "open" : "deferred";
        case "dismissed":
            return "dismissed";
        case "completed":
            return "completed";
    }
}

function normalizeChunks(chunkIds: readonly string[]): string[] {
    return Array.from(new Set(chunkIds.filter((chunkId) => chunkId.trim().length > 0))).sort((left, right) => left.localeCompare(right));
}
