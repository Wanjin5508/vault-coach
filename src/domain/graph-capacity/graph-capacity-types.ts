/**
 * Local-only facts used to decide whether semantic graph work is safe to run
 * inside the Obsidian plugin process. None of these values are persisted.
 */
export interface GraphCapacityInput {
    fileCount: number | null;
    chunkCount: number | null;
    documentCount: number | null;
    sectionCount: number | null;
    structuralEdgeCount: number | null;
    indexedTextBytes: number | null;
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
