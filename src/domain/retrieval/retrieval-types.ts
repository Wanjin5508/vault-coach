import type { DocumentLocator, IndexedChunk, KnowledgeDocumentType } from "../documents/document-types";

export type { KeywordSearchHit } from "../documents/document-types";

export type RetrievalMode = "keyword" | "vector" | "hybrid";

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

export interface VectorStore {
    initialize(): Promise<void>;
    upsert(records: VectorRecord[]): Promise<void>;
    remove(chunkIds: string[]): Promise<void>;
    search(queryVector: Float32Array, options: VectorSearchOptions): Promise<VectorStoreHit[]>;
    clear(): Promise<void>;
    getStats(): Promise<VectorStoreStats>;
    close(): Promise<void>;
}
