import type {
    IndexedChunk,
    KeywordSearchHit,
    KnowledgeBaseFileRecord,
    KnowledgeBaseStats,
} from "./document-types";

/**
 * Read-only access to the current document index.
 *
 * Domain services depend on this port instead of the Obsidian-backed
 * VaultKnowledgeBase implementation. Index construction and persistence remain
 * outside this interface.
 */
export interface DocumentIndexReader {
    isReady(): boolean;
    getStats(): KnowledgeBaseStats;
    getAllChunks(): IndexedChunk[];
    getChunkById(chunkId: string): IndexedChunk | null;
    getChunksByIds(chunkIds: readonly string[]): IndexedChunk[];
    getChunksByFilePath(filePath: string): IndexedChunk[];
    getFileRecords(): KnowledgeBaseFileRecord[];
    getFileRecord(filePath: string): KnowledgeBaseFileRecord | null;
    readDocumentText(filePath: string): Promise<string | null>;
    searchKeyword(query: string, limit: number): KeywordSearchHit[];
}
