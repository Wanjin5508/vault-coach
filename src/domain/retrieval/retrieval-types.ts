/**
 * 检索管线的跨层数据契约。
 *
 * `score` 只在其所属阶段内比较；关键词分数、向量相似度、融合分数和重排分数
 * 不共享数值尺度。基础设施实现不得把向量存储的内部记录泄露给展示层。
 */
import type { DocumentLocator, IndexedChunk, KnowledgeDocumentType } from "../documents/document-types";

export type { KeywordSearchHit } from "../documents/document-types";

export type RetrievalMode = "keyword" | "vector" | "hybrid";

/** 发送给回答生成器并最终展示给用户的可追溯来源。 */
export interface AnswerSource {
    filePath: string;
    locator?: DocumentLocator;
    heading?: string;
    pageStart?: number;
    pageEnd?: number;
    displayLink: string;
    excerpt: string;
}

export interface ChunkEmbedding {
    chunkId: string;
    vector: number[];
}

export interface VectorRecord {
    chunkId: string;
    vector: Float32Array;
    metadata: {
        documentId: string;
        documentType: KnowledgeDocumentType;
        filePath?: string;
        pageStart?: number;
        pageEnd?: number;
    };
}

export interface VectorSearchOptions {
    topK: number;
    filter?: {
        documentIds?: string[];
        documentTypes?: KnowledgeDocumentType[];
        folderPaths?: string[];
    };
}

export interface VectorStoreHit {
    chunkId: string;
    score: number;
    similarity: number;
}

export interface VectorStoreStats {
    backend: "embedded-exact" | "embedded-ann" | "external";
    vectorCount: number;
    dimension: number | null;
    persistedBytes: number;
    loadedBytes: number;
    lastUpdatedAt: number | null;
}

export interface VectorSearchHit {
    chunk: IndexedChunk;
    score: number;
    similarity: number;
}

export interface RetrievalCandidate {
    chunk: IndexedChunk;
    score: number;
    matchedTokens: string[];
    retrievalChannels: RetrievalMode[];
    keywordScore?: number;
    vectorScore?: number;
}

export interface RerankedCandidate extends RetrievalCandidate {
    retrievalScore: number;
    rerankScore: number;
    finalScore: number;
}

export interface QueryRewriteResult {
    originalQuery: string;
    rewrittenQuery: string;
    useRewrite: boolean;
}

export interface VectorIndexStats {
    ready: boolean;
    vectorCount: number;
    dimension: number | null;
    lastBuiltAt: number | null;
}

export interface AssistantAnswer {
    text: string;
    sources: AnswerSource[];
    generationDurationMs?: number;
    retrievalModeUsed: RetrievalMode;
    queryRewrite: QueryRewriteResult;
}

export interface RerankResultItem {
    index: number;
    relevance_score: number;
}

/**
 * 向量后端端口。实现必须接受重复初始化和幂等删除，并在 `close` 后释放持有资源。
 * `search` 返回的 `score` 由后端定义，调用方应使用 `similarity` 表示统一的相似度语义。
 */
export interface VectorStore {
    initialize(): Promise<void>;
    upsert(records: VectorRecord[]): Promise<void>;
    remove(chunkIds: string[]): Promise<void>;
    search(queryVector: Float32Array, options: VectorSearchOptions): Promise<VectorStoreHit[]>;
    clear(): Promise<void>;
    getStats(): Promise<VectorStoreStats>;
    close(): Promise<void>;
}
