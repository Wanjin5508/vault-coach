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

export interface KnowledgeBaseSnapshot {
    version: number;
    settingsSignature: string;
    embeddingModel: string | null;
    stats: KnowledgeBaseStats;
    vectorStats: VectorIndexStats;
    chunks: IndexedChunk[];
    embeddings?: ChunkEmbedding[];
    files: KnowledgeBaseFileRecord[];
    /** Version 3+: prevents stale index restoration after offline Vault changes. */
    sourceInventory?: SourceInventoryV1;
}

export interface PersistedPluginState {
    messages: ChatMessage[];
    memories: MemoryItem[];
    lastAutoIndexAt: number | null;
}
