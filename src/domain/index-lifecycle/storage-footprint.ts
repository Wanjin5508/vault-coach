/** Vault Coach 派生数据的只读本地磁盘统计。 */
export type StorageFootprintCategory =
    | "text-index"
    | "vector-index"
    | "deterministic-graph"
    | "semantic-facts"
    | "semantic-embeddings"
    | "mastery"
    | "recommendation-actions"
    | "assessments"
    | "exam-reports";

export interface StorageFootprintEntry {
    category: StorageFootprintCategory;
    bytes: number;
    fileCount: number;
    latestModifiedAt: number | null;
    /** 在可低成本获取时，记录该类别对应的领域记录数。 */
    recordCount: number | null;
}

export interface StorageFootprint {
    generatedAt: number;
    totalBytes: number;
    entries: StorageFootprintEntry[];
}
