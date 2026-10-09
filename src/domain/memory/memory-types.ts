/**
 * 长期记忆的领域契约。记忆内容来自用户允许保留的会话信息，时间戳单位为 Unix 毫秒。
 * 搜索命中是临时排序结果，不应作为新的持久化事实写回。
 */
export interface MemoryItem {
    id: string;
    text: string;
    createdAt: number;
    updatedAt: number;
    lastAccessedAt: number;
}

/** 单次记忆搜索的派生结果；`score` 仅在同一次查询内比较。 */
export interface MemorySearchHit {
    item: MemoryItem;
    score: number;
    matchedTokens: string[];
}
