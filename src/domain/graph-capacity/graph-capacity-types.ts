/**
 * 用于判断语义图任务能否安全运行在 Obsidian 插件进程内的本地事实。
 * 这些值只参与运行时决策，不进行持久化。
 */
export interface GraphCapacityInput {
    fileCount: number | null;
    chunkCount: number | null;
    documentCount: number | null;
    sectionCount: number | null;
    structuralEdgeCount: number | null;
    indexedTextBytes: number | null;
    /** 需要分别执行语义模型抽取的 Section 窗口数。 */
    semanticInputCount: number | null;
    /** 将发送给语义抽取模型的全部 Section 窗口字符数。 */
    semanticInputCharacters: number | null;
    extractionCount: number | null;
    conceptCount: number | null;
    candidateCount: number | null;
    effectiveRelationCount: number | null;
    embeddingCount: number | null;
    vectorCount: number | null;
    vectorDimension: number | null;
}

export type GraphCapacityLevel =
    | "local"
    | "warning"
    | "service-preferred"
    | "service-required";

export type GraphCapacityMetric =
    | "semantic-input-count"
    | "semantic-input-characters"
    | "chunk-count"
    | "section-count"
    | "indexed-text-bytes"
    | "concept-count"
    | "semantic-relation-count"
    | "raw-vector-bytes";

export interface GraphCapacityReason {
    metric: GraphCapacityMetric;
    actual: number;
    threshold: number;
    level: Exclude<GraphCapacityLevel, "local">;
}

export interface GraphCapacityAssessment {
    level: GraphCapacityLevel;
    reasons: GraphCapacityReason[];
    rawVectorBytes: number | null;
    hasUnknownMetrics: boolean;
    allowManualSemanticBuild: boolean;
    allowAutomaticSemanticSync: boolean;
}
