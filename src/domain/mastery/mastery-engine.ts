import type { AssessmentErrorCode } from "../exam/exam-types";
import { MasteryBindingResolver, type ResolvedMasteryEvidence } from "./mastery-binding-resolver";
import {
    DEFAULT_MASTERY_ALGORITHM,
    type ConceptMasteryState,
    type MasteryAlgorithmConfig,
    type MasteryAssessmentAnalysis,
    type MasteryCalculationInput,
    type MasteryCalculationResult,
    type MasteryEvidenceContribution,
    type MasteryLevel,
    type MasteryTrend,
} from "./mastery-types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure, deterministic M4B calculator. It has no storage, model, or UI dependency. */
export class MasteryEngine {
    private readonly resolver = new MasteryBindingResolver();

    calculateAll(input: MasteryCalculationInput): MasteryCalculationResult {
        const algorithm = input.algorithm ?? DEFAULT_MASTERY_ALGORITHM;
        const analysis = this.analyze(input);
        const resolvedByConcept = groupResolvedByConcept(analysis.resolvedEvidence);
        return {
            states: input.catalog.concepts
                .map((concept) => this.calculateConceptFromResolved(concept.id, resolvedByConcept.get(concept.id) ?? [], input.now, algorithm))
                .sort((left, right) => left.conceptId.localeCompare(right.conceptId)),
            sourceEventCount: analysis.activeAssessments.length,
            unboundIssues: analysis.unboundIssues,
        };
    }

    recalculateConcepts(input: MasteryCalculationInput, conceptIds: readonly string[]): ConceptMasteryState[] {
        const algorithm = input.algorithm ?? DEFAULT_MASTERY_ALGORITHM;
        const requested = new Set(conceptIds);
        const analysis = this.analyze(input);
        const resolvedByConcept = groupResolvedByConcept(analysis.resolvedEvidence);
        return input.catalog.concepts
            .filter((concept) => requested.has(concept.id))
            .map((concept) => this.calculateConceptFromResolved(concept.id, resolvedByConcept.get(concept.id) ?? [], input.now, algorithm))
            .sort((left, right) => left.conceptId.localeCompare(right.conceptId));
    }

    /**
     * Returns the exact same active-evidence set used by both calculation paths.
     * The application service uses it to refresh snapshot metadata without
     * recalculating unrelated Concept states.
     */
    analyze(input: Pick<MasteryCalculationInput, "assessments" | "catalog">): MasteryAssessmentAnalysis {
        const activeAssessments = selectActiveAssessments(input.assessments);
        const resolution = this.resolver.resolve(activeAssessments, input.catalog);
        return {
            activeAssessments: [...activeAssessments],
            resolvedEvidence: [...resolution.resolved],
            unboundIssues: [...resolution.issues],
        };
    }

    private calculateConceptFromResolved(
        conceptId: string,
        resolved: readonly ResolvedMasteryEvidence[],
        now: number,
        algorithm: MasteryAlgorithmConfig,
    ): ConceptMasteryState {
        const evidence = resolved
            .map((item) => createContribution(item, now, algorithm))
            .sort((left, right) => left.occurredAt - right.occurredAt || left.eventId.localeCompare(right.eventId));
        const effective = evidence.filter((item) => item.weight > 0);
        const totalWeight = effective.reduce((total, item) => total + item.weight, 0);
        if (totalWeight <= 0) return createUnknownState(conceptId, evidence, now, algorithm.version);
        const masteryScore = effective.reduce((total, item) => total + item.normalizedScore * item.weight, 0) / totalWeight;
        const confidence = clampProbability(1 - Math.exp(-totalWeight));
        const level = calculateLevel(masteryScore, confidence, algorithm);
        const lastAssessedAt = evidence.at(-1)?.occurredAt ?? null;
        return {
            conceptId,
            masteryScore,
            confidence,
            level,
            assessmentCount: evidence.length,
            effectiveEvidenceCount: effective.length,
            lastAssessedAt,
            lastReviewedAt: null,
            nextReviewAt: lastAssessedAt === null ? null : lastAssessedAt + reviewIntervalMs(level),
            commonErrorCodes: aggregateErrors(effective),
            trend: calculateTrend(effective, algorithm),
            evidence,
            calculatedAt: now,
            algorithmVersion: algorithm.version,
        };
    }
}

function selectActiveAssessments<T extends { event: { id: string; supersedesEventId?: string } }>(assessments: readonly T[]): T[] {
    const superseded = new Set(assessments.flatMap((assessment) => assessment.event.supersedesEventId ? [assessment.event.supersedesEventId] : []));
    const byEventId = new Map<string, T>();
    for (const assessment of [...assessments].sort((left, right) => left.event.id.localeCompare(right.event.id))) {
        if (!byEventId.has(assessment.event.id)) byEventId.set(assessment.event.id, assessment);
    }
    return Array.from(byEventId.values()).filter((assessment) => !superseded.has(assessment.event.id));
}

function groupResolvedByConcept(resolved: readonly ResolvedMasteryEvidence[]): Map<string, ResolvedMasteryEvidence[]> {
    const grouped = new Map<string, ResolvedMasteryEvidence[]>();
    for (const item of resolved) {
        const values = grouped.get(item.conceptId) ?? [];
        values.push(item);
        grouped.set(item.conceptId, values);
    }
    return grouped;
}

function createContribution(item: ResolvedMasteryEvidence, now: number, algorithm: MasteryAlgorithmConfig): MasteryEvidenceContribution {
    const event = item.input.event;
    const elapsedDays = Math.max(0, now - event.occurredAt) / DAY_MS;
    const difficultyWeight = algorithm.difficultyWeights[event.difficulty];
    const weight = Math.max(0, difficultyWeight * clampProbability(event.evidenceConfidence) * clampProbability(event.evaluationConfidence) * Math.exp(-algorithm.decayRatePerDay * elapsedDays));
    return {
        eventId: event.id,
        sessionId: event.sessionId,
        questionId: event.questionId,
        bindingKind: item.bindingKind,
        normalizedScore: clampProbability(event.normalizedScore),
        weight,
        occurredAt: event.occurredAt,
        difficulty: event.difficulty,
        errorCodes: Array.from(new Set(event.errorCodes)).sort((left, right) => left.localeCompare(right)),
    };
}

function createUnknownState(conceptId: string, evidence: readonly MasteryEvidenceContribution[], now: number, algorithmVersion: string): ConceptMasteryState {
    return {
        conceptId,
        masteryScore: null,
        confidence: 0,
        level: "unknown",
        assessmentCount: evidence.length,
        effectiveEvidenceCount: 0,
        lastAssessedAt: evidence.at(-1)?.occurredAt ?? null,
        lastReviewedAt: null,
        nextReviewAt: null,
        commonErrorCodes: [],
        trend: "unknown",
        evidence: [...evidence],
        calculatedAt: now,
        algorithmVersion,
    };
}

function calculateLevel(score: number, confidence: number, algorithm: MasteryAlgorithmConfig): MasteryLevel {
    if (score < 0.45) return "weak";
    if (score < 0.7) return "developing";
    if (score < algorithm.masteredScoreThreshold) return "proficient";
    return confidence >= algorithm.masteredConfidenceThreshold ? "mastered" : "proficient";
}

function reviewIntervalMs(level: MasteryLevel): number {
    if (level === "weak") return DAY_MS;
    if (level === "developing") return DAY_MS * 3;
    if (level === "proficient") return DAY_MS * 7;
    if (level === "mastered") return DAY_MS * 21;
    return 0;
}

function aggregateErrors(evidence: readonly MasteryEvidenceContribution[]): AssessmentErrorCode[] {
    const counts = new Map<AssessmentErrorCode, number>();
    for (const item of evidence) {
        for (const code of item.errorCodes) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return Array.from(counts.entries())
        .sort(([leftCode, leftCount], [rightCode, rightCount]) => rightCount - leftCount || leftCode.localeCompare(rightCode))
        .map(([code]) => code);
}

function calculateTrend(evidence: readonly MasteryEvidenceContribution[], algorithm: MasteryAlgorithmConfig): MasteryTrend {
    if (evidence.length < 2) return "unknown";
    const split = Math.floor(evidence.length / 2);
    const earlier = weightedAverage(evidence.slice(0, split));
    const later = weightedAverage(evidence.slice(split));
    if (later - earlier >= algorithm.trendDeltaThreshold) return "improving";
    if (earlier - later >= algorithm.trendDeltaThreshold) return "declining";
    return "stable";
}

function weightedAverage(evidence: readonly MasteryEvidenceContribution[]): number {
    const weight = evidence.reduce((total, item) => total + item.weight, 0);
    return weight > 0 ? evidence.reduce((total, item) => total + item.weight * item.normalizedScore, 0) / weight : 0;
}

function clampProbability(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
