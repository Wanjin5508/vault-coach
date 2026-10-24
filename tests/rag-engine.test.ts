import { describe, expect, it, vi } from "vitest";
import { AdvancedRagEngine } from "../src/rag-engine";
import { createDefaultSettings } from "../src/app/config/settings-defaults";
import { EmbeddingError } from "../src/domain/embedding/embedding-error";
import { createEmbeddingFingerprint } from "../src/domain/embedding/embedding-fingerprint";
import type { DocumentIndexReader } from "../src/domain/documents/document-index-reader";
import type { IndexedChunk } from "../src/domain/documents/document-types";
import type { EmbeddingProvider } from "../src/domain/embedding/embedding-provider";
import type { VectorStore } from "../src/domain/retrieval/retrieval-types";

const chunk: IndexedChunk = {
    id: "chunk-1",
    documentId: "doc-1",
    documentType: "markdown",
    filePath: "notes/a.md",
    fileName: "a.md",
    headingPath: ["A"],
    primaryHeading: "A",
    text: "keyword fallback content",
    searchableText: "keyword fallback content",
    locator: { type: "markdown", filePath: "notes/a.md", heading: "A" },
    contentKind: "native-text",
};

const descriptor = {
    providerId: "ollama" as const,
    endpointIdentity: "http://localhost:11434",
    model: "nomic-embed-text",
    revision: "unverified",
    modelDtype: "server-managed",
    outputDtype: "float32" as const,
    pooling: "server-managed",
    normalization: "l2-client",
    preprocessing: { document: "identity", query: "identity", graph: "identity" },
    implementationVersion: 1,
};
const fingerprint = createEmbeddingFingerprint(descriptor, 3);

describe("AdvancedRagEngine vector compatibility", () => {
    it("marks the vector index stale, notifies the coordinator, and falls back to keyword retrieval", async () => {
        const documentIndex: DocumentIndexReader = {
            isReady: () => true,
            getStats: () => ({
                fileCount: 1,
                chunkCount: 1,
                totalCharacters: chunk.text.length,
                lastIndexedAt: 1,
                scopeDescription: "whole vault",
            }),
            getAllChunks: () => [chunk],
            getChunkById: () => chunk,
            getChunksByIds: () => [chunk],
            getChunksByFilePath: () => [chunk],
            getFileRecords: () => [],
            getFileRecord: () => null,
            readDocumentText: async () => chunk.text,
            searchKeyword: () => [{ chunk, score: 1, matchedTokens: ["keyword"] }],
        };
        const vectorStore: VectorStore = {
            initialize: async () => undefined,
            replaceAll: async () => ({ backend: "embedded-exact", vectorCount: 1, dimension: 3, persistedBytes: 12, loadedBytes: 12, lastUpdatedAt: 1 }),
            upsert: async () => undefined,
            remove: async () => undefined,
            search: async () => { throw new EmbeddingError("fingerprint-mismatch", "ollama", "stale"); },
            inspect: async () => ({ status: "ready", fingerprint, stats: { backend: "embedded-exact", vectorCount: 1, dimension: 3, persistedBytes: 12, loadedBytes: 12, lastUpdatedAt: 1 } }),
            clear: async () => undefined,
            getStats: async () => ({ backend: "embedded-exact", vectorCount: 1, dimension: 3, persistedBytes: 12, loadedBytes: 12, lastUpdatedAt: 1 }),
            close: async () => undefined,
        };
        const embeddingProvider: EmbeddingProvider = {
            id: "ollama",
            describe: () => descriptor,
            embed: async () => ({
                vectors: [new Float32Array([1, 0, 0])],
                fingerprint,
                diagnostics: { providerId: "ollama", transport: "ollama-modern", latencyMs: 1, attempts: 1, cpuFallbackUsed: false, revisionVerified: false },
            }),
        };
        const onVectorIncompatible = vi.fn();
        const settings = { ...createDefaultSettings(), retrievalPreference: "vector" as const, enableRerank: false };
        const engine = new AdvancedRagEngine(documentIndex, vectorStore, () => settings, () => "vector", {
            embeddingProvider,
            onVectorIncompatible,
            queryRewrite: { rewriteQuery: async ({ originalQuery }) => ({ originalQuery, rewrittenQuery: originalQuery, useRewrite: false }) },
            memoryExtraction: { extractMemoryStatements: async () => [] },
            rerankProvider: { rerank: async () => [] },
            chatProvider: {
                rewriteQuery: async (originalQuery) => ({ originalQuery, rewrittenQuery: originalQuery, useRewrite: false }),
                extractMemoryStatements: async () => [],
                generateMarkdownAnswer: async () => "fallback answer",
                generateJsonAnswer: async () => "{}",
                streamMarkdownAnswer: async () => "fallback answer",
            },
        });
        engine.hydrateVectorStats({ ready: true, vectorCount: 1, dimension: 3, lastBuiltAt: 1, compatibility: "compatible" });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const answer = await engine.answerQuestion("keyword", [], "whole vault", "");

        expect(answer.retrievalModeUsed).toBe("keyword");
        expect(answer.retrievalReason).toBe("vector-failed");
        expect(engine.getVectorIndexStats()).toMatchObject({ ready: false, compatibility: "stale" });
        expect(onVectorIncompatible).toHaveBeenCalledOnce();
        expect(onVectorIncompatible).toHaveBeenCalledWith("fingerprint-mismatch");
        consoleError.mockRestore();
    });
});
