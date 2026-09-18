/** Read-only local disk accounting for VaultCoach-derived data. */
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
    /** Domain records represented by this category when cheap to obtain. */
    recordCount: number | null;
}

export interface StorageFootprint {
    generatedAt: number;
    totalBytes: number;
    entries: StorageFootprintEntry[];
}
