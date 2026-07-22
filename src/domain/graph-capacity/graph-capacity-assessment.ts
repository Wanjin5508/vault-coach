import type {
    GraphCapacityAssessment,
    GraphCapacityInput,
    GraphCapacityLevel,
    GraphCapacityMetric,
    GraphCapacityReason,
} from "./graph-capacity-types";

interface CapacityThresholds {
    warning: number;
    servicePreferred: number;
    serviceRequired: number;
}

const THRESHOLDS: Record<GraphCapacityMetric, CapacityThresholds> = {
    "chunk-count": { warning: 8_000, servicePreferred: 25_000, serviceRequired: 50_000 },
    "section-count": { warning: 1_000, servicePreferred: 2_500, serviceRequired: 5_000 },
    "indexed-text-bytes": { warning: 10 * 1024 * 1024, servicePreferred: 25 * 1024 * 1024, serviceRequired: 50 * 1024 * 1024 },
    "concept-count": { warning: 2_000, servicePreferred: 5_000, serviceRequired: 10_000 },
    "semantic-relation-count": { warning: 10_000, servicePreferred: 25_000, serviceRequired: 100_000 },
    "raw-vector-bytes": { warning: Number.POSITIVE_INFINITY, servicePreferred: 128 * 1024 * 1024, serviceRequired: 256 * 1024 * 1024 },
};

const LEVELS: readonly Exclude<GraphCapacityLevel, "local">[] = [
    "service-required",
    "service-preferred",
    "warning",
];

/**
 * Pure capacity policy. It does no Vault IO, model call, embedding, or graph
 * traversal, so it is safe to run before a semantic rebuild or auto-sync.
 */
export function assessGraphCapacity(input: GraphCapacityInput): GraphCapacityAssessment {
    const rawVectorBytes = estimateRawVectorBytes(input.vectorCount, input.vectorDimension);
    const metricValues: ReadonlyArray<[GraphCapacityMetric, number | null]> = [
        ["chunk-count", input.chunkCount],
        ["section-count", input.sectionCount],
        ["indexed-text-bytes", input.indexedTextBytes],
        ["concept-count", input.conceptCount],
        ["semantic-relation-count", sumKnown(input.candidateCount, input.effectiveRelationCount)],
        ["raw-vector-bytes", rawVectorBytes],
    ];
    const reasons = metricValues.flatMap(([metric, value]) => value === null ? [] : getReasons(metric, value));
    const level = getHighestLevel(reasons);
    return {
        level,
        reasons: reasons.sort(compareReasons),
        rawVectorBytes,
        hasUnknownMetrics: hasUnknownMetric(input),
        allowManualSemanticBuild: level === "local" || level === "warning",
        allowAutomaticSemanticSync: level === "local",
    };
}

function getReasons(metric: GraphCapacityMetric, rawValue: number): GraphCapacityReason[] {
    const value = normalizeCount(rawValue);
    const thresholds = THRESHOLDS[metric];
    const reasons: GraphCapacityReason[] = [];
    for (const level of LEVELS) {
        const threshold = thresholdForLevel(thresholds, level);
        if (value > threshold) reasons.push({ metric, actual: value, threshold, level });
    }
    return reasons;
}

function getHighestLevel(reasons: readonly GraphCapacityReason[]): GraphCapacityLevel {
    if (reasons.some((reason) => reason.level === "service-required")) return "service-required";
    if (reasons.some((reason) => reason.level === "service-preferred")) return "service-preferred";
    if (reasons.some((reason) => reason.level === "warning")) return "warning";
    return "local";
}

function thresholdForLevel(thresholds: CapacityThresholds, level: Exclude<GraphCapacityLevel, "local">): number {
    if (level === "warning") return thresholds.warning;
    if (level === "service-preferred") return thresholds.servicePreferred;
    return thresholds.serviceRequired;
}

function estimateRawVectorBytes(vectorCount: number | null, dimension: number | null): number | null {
    if (vectorCount === null || dimension === null) return null;
    return normalizeCount(vectorCount) * normalizeCount(dimension) * 4;
}

function sumKnown(left: number | null, right: number | null): number | null {
    if (left === null || right === null) return null;
    return normalizeCount(left) + normalizeCount(right);
}

function hasUnknownMetric(input: GraphCapacityInput): boolean {
    return Object.values(input).some((value) => value === null);
}

function normalizeCount(value: number): number {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function compareReasons(left: GraphCapacityReason, right: GraphCapacityReason): number {
    return left.metric.localeCompare(right.metric)
        || right.threshold - left.threshold
        || right.actual - left.actual;
}
