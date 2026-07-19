import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { VaultCoachSettings } from "../src/app/config/settings-types";
import type { DocumentIndexReader } from "../src/domain/documents/document-index-reader";
import type {
    IndexedChunk,
    KnowledgeBaseFileRecord,
    KnowledgeBaseStats,
} from "../src/domain/documents/document-types";
import { VaultKnowledgeBase } from "../src/knowledge-base";

const settings: VaultCoachSettings = {
    knowledgeScopeMode: "wholeVault",
    knowledgeFolder: "",
} as VaultCoachSettings;

const chunk: IndexedChunk = {
    id: "chunk-rag-1",
    documentId: "markdown:知识库/RAG.md",
    documentType: "markdown",
    filePath: "知识库/RAG.md",
    fileName: "RAG.md",
    headingPath: ["RAG", "混合检索"],
    primaryHeading: "混合检索",
    text: "混合检索结合关键词检索和向量检索。",
    searchableText: "RAG 混合检索 混合检索结合关键词检索和向量检索。",
    locator: {
        type: "markdown",
        filePath: "知识库/RAG.md",
        heading: "混合检索",
    },
    contentKind: "native-text",
};

const record: KnowledgeBaseFileRecord = {
    documentId: chunk.documentId,
    documentType: chunk.documentType,
    filePath: chunk.filePath,
    contentHash: "fixture-hash",
    chunkIds: [chunk.id],
    indexedAt: 1704164645000,
};

const stats: KnowledgeBaseStats = {
    fileCount: 1,
    chunkCount: 1,
    lastIndexedAt: 1704164645000,
    scopeDescription: "整个 Vault",
};

function createReader(): DocumentIndexReader {
    const knowledgeBase = new VaultKnowledgeBase({} as App, () => settings);
    knowledgeBase.loadFromSnapshot({
        stats,
        chunks: [chunk],
        files: [record],
    });
    return knowledgeBase;
}

describe("DocumentIndexReader", () => {
    it("exposes generic chunk, file record, and keyword search queries", () => {
        const reader = createReader();

        expect(reader.isReady()).toBe(true);
        expect(reader.getStats()).toMatchObject(stats);
        expect(reader.getChunkById(chunk.id)).toEqual(chunk);
        expect(reader.getChunkById("missing")).toBeNull();
        expect(reader.getChunksByIds(["missing", chunk.id]).map((item) => item.id)).toEqual([chunk.id]);
        expect(reader.getChunksByFilePath(chunk.filePath).map((item) => item.id)).toEqual([chunk.id]);
        expect(reader.searchKeyword("混合检索", 5).map((item) => item.chunk.id)).toEqual([chunk.id]);
    });

    it("does not expose the stored file record's chunk ID array for mutation", () => {
        const reader = createReader();
        const firstRead = reader.getFileRecord(chunk.filePath);

        expect(firstRead).not.toBeNull();
        firstRead?.chunkIds.push("mutated");

        expect(reader.getFileRecord(chunk.filePath)?.chunkIds).toEqual([chunk.id]);
    });
});
