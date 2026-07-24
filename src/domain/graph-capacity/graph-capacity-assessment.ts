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
    // One semantic input window needs at least one serial model request and
    // often a second relation request. This is the primary Lite workload
    // metric; raw file count alone does not predict a rebuild's duration.
    // Lite's explicit local-build contract is based on the number of semantic
    // model windows: 301–500 needs an acknowledgement, while >500 is refused.
    "semantic-input-count": { warning: 300, servicePreferred: 500, serviceRequired: 500 },
    // The remaining metrics are warning-only diagnostics. The explicit
    // product contract is that a Vault with <=500 semantic windows can still
    // be built locally after the user acknowledges the cost.
    "semantic-input-characters": { warning: 10 * 1024 * 1024, servicePreferred: Number.POSITIVE_INFINITY, serviceRequired: Number.POSITIVE_INFINITY },
    "chunk-count": { warning: 8_000, servicePreferred: Number.POSITIVE_INFINITY, serviceRequired: Number.POSITIVE_INFINITY },
    "section-count": { warning: 1_000, servicePreferred: Number.POSITIVE_INFINITY, serviceRequired: Number.POSITIVE_INFINITY },
    "indexed-text-bytes": { warning: 10 * 1024 * 1024, servicePreferred: Number.POSITIVE_INFINITY, serviceRequired: Number.POSITIVE_INFINITY },
    "concept-count": { warning: 2_000, servicePreferred: Number.POSITIVE_INFINITY, serviceRequired: Number.POSITIVE_INFINITY },
    "semantic-relation-count": { warning: 10_000, servicePreferred: Number.POSITIVE_INFINITY, serviceRequired: Number.POSITIVE_INFINITY },
    "raw-vector-bytes": { warning: 128 * 1024 * 1024, servicePreferred: Number.POSITIVE_INFINITY, serviceRequired: Number.POSITIVE_INFINITY },
};

const LEVELS: readonly Exclude<GraphCapacityLevel, "local">[] = [
    "service-required",
    "service-preferred",
    "warning",
];

/**
 * Pure capacity policy. It does no Vault IO, model call, embedding, or graph
 * traversal; callers may feed it counts derived from their cached snapshot.
 */
export function assessGraphCapacity(input: GraphCapacityInput): GraphCapacityAssessment {
    const rawVectorBytes = estimateRawVectorBytes(input.vectorCount, input.vectorDimension);
    const metricValues: ReadonlyArray<[GraphCapacityMetric, number | null]> = [
        ["semantic-input-count", input.semanticInputCount],
        ["semantic-input-characters", input.semanticInputCharacters],
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
