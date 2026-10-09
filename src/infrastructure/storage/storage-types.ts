/** 插件持久化文件使用的版本化数据契约。基础设施负责兼容读取，领域层不依赖文件布局。 */
import type {
    ChunkEmbedding,
    VectorIndexStats,
} from "../../domain/retrieval/retrieval-types";
import type {
    ChatMessage,
} from "../../app/chat/chat-types";
import type {
    IndexedChunk,
    KnowledgeBaseFileRecord,
    KnowledgeBaseStats,
} from "../../domain/documents/document-types";
import type { MemoryItem } from "../../domain/memory/memory-types";
import type { SourceInventoryV1 } from "../../domain/index-lifecycle/source-inventory";

/**
 * 可重建知识索引的落盘快照。
 * `settingsSignature` 和 `embeddingModel` 用于拒绝与当前运行配置不兼容的缓存。
 */
export interface KnowledgeBaseSnapshot {
    version: number;
    settingsSignature: string;
    embeddingModel: string | null;
    stats: KnowledgeBaseStats;
    vectorStats: VectorIndexStats;
    chunks: IndexedChunk[];
    embeddings?: ChunkEmbedding[];
    files: KnowledgeBaseFileRecord[];
    /** 版本 3 及以上：防止离线 Vault 变更后恢复过期索引。 */
    sourceInventory?: SourceInventoryV1;
}

/**
 * 插件轻量运行状态。消息和记忆是用户状态；索引与图谱使用独立快照保存，不能混入此结构。
 */
export interface PersistedPluginState {
    messages: ChatMessage[];
    memories: MemoryItem[];
    lastAutoIndexAt: number | null;
}
