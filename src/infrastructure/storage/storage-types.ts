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

export interface KnowledgeBaseSnapshot {
    version: number;
    settingsSignature: string;
    embeddingModel: string | null;
    stats: KnowledgeBaseStats;
    vectorStats: VectorIndexStats;
    chunks: IndexedChunk[];
    embeddings?: ChunkEmbedding[];
    files: KnowledgeBaseFileRecord[];
}

export interface PersistedPluginState {
    messages: ChatMessage[];
    memories: MemoryItem[];
    lastAutoIndexAt: number | null;
}
