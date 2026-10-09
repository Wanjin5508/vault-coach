/** 知识索引互斥任务的阶段；任一时刻最多只能暴露一个活动阶段。 */
export type KnowledgeIndexBusyPhase = "rebuilding" | "syncing" | "vector";

/** 展示层使用的索引任务状态；空闲时 `phase` 和 `startedAt` 必须同时为空。 */
export interface KnowledgeIndexBusyState {
    busy: boolean;
    phase: KnowledgeIndexBusyPhase | null;
    startedAt: number | null;
}
