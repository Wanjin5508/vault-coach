import type {
    IndexedChunk,
    KeywordSearchHit,
    KnowledgeBaseFileRecord,
    KnowledgeBaseStats,
} from "./document-types";

/**
 * 当前文档索引的只读访问端口。
 *
 * 领域服务依赖该端口，而不是依赖由 Obsidian 支撑的 `VaultKnowledgeBase` 实现。
 * 索引构建与持久化不属于本接口职责。
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
