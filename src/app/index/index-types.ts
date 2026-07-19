export type KnowledgeIndexBusyPhase = "rebuilding" | "syncing" | "vector";

export interface KnowledgeIndexBusyState {
    busy: boolean;
    phase: KnowledgeIndexBusyPhase | null;
    startedAt: number | null;
}
