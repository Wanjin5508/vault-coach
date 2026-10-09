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

export const LITE_SEMANTIC_AUTO_WINDOW_LIMIT = 400;
export const LITE_SEMANTIC_MANUAL_WINDOW_LIMIT = 650;

const THRESHOLDS: Record<GraphCapacityMetric, CapacityThresholds> = {
    // 每个语义输入窗口至少需要一次串行模型请求，通常还需要第二次关系请求。
    // 因此语义窗口数是 Lite 的主要工作量指标，原始文件数不能单独预测重建耗时。
    // Lite 本地构建契约按语义模型窗口计数：401–650 需要用户确认，超过 650 拒绝执行。
    "semantic-input-count": {
        warning: LITE_SEMANTIC_AUTO_WINDOW_LIMIT,
        servicePreferred: LITE_SEMANTIC_MANUAL_WINDOW_LIMIT,
        serviceRequired: LITE_SEMANTIC_MANUAL_WINDOW_LIMIT,
    },
    // 其余指标仅用于诊断警告。产品契约明确规定：语义窗口不超过 650 时，
    // 用户确认资源成本后仍可在本地构建。
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
 * 纯容量策略。
 *
 * 不执行 Vault I/O、模型调用、embedding 或图遍历；调用方可以传入缓存快照派生的计数。
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
