import { describe, expect, it, vi } from "vitest";
import { AdvancedRagEngine } from "../../src/rag-engine";
import { createDefaultSettings } from "../../src/app/config/settings-defaults";
import type { DocumentIndexReader } from "../../src/domain/documents/document-index-reader";
import type { IndexedChunk } from "../../src/domain/documents/document-types";
import type { EmbeddingProvider } from "../../src/domain/embedding/embedding-provider";
import type { RerankProvider, RerankRequest } from "../../src/domain/rerank/rerank-provider";
import type { VectorStore } from "../../src/domain/retrieval/retrieval-types";

describe("AdvancedRagEngine rerank compatibility", () => {
    it("preserves rerankTopK semantics and maps provider scores back to stable chunk IDs", async () => {
        const chunks = [
            createChunk("first", "first retrieval result"),
            createChunk("second", "second retrieval result"),
            createChunk("third", "third retrieval result"),
        ];
        let captured: RerankRequest | null = null;
        const rerankProvider: RerankProvider = {
            rerank: async (request) => {
                captured = request;
                return [
                    { candidateId: "second", score: 0.9 },
                    { candidateId: "first", score: 0.1 },
                ];
            },
        };
        const engine = createEngine(chunks, rerankProvider, {
            rerankTopK: 2,
            contextTopK: 1,
            answerSourceLimit: 2,
        });

        const answer = await engine.answerQuestion("query", [], "whole vault", "");

        expect(captured).not.toBeNull();
        const capturedRequest = captured as RerankRequest | null;
        expect(capturedRequest?.candidates.map((candidate) => candidate.id)).toEqual(["first", "second"]);
        expect(capturedRequest?.candidates[0]?.text).toContain("notes/first.md");
        expect(answer.sources.map((source) => source.filePath)).toEqual(["notes/second.md", "notes/first.md"]);
    });

    it("keeps the original retrieval order when rerank is disabled", async () => {
        const rerank = vi.fn(async () => [{ candidateId: "second", score: 1 }]);
        const engine = createEngine([
            createChunk("first", "first retrieval result"),
            createChunk("second", "second retrieval result"),
        ], { rerank }, { enableRerank: false });

        const answer = await engine.answerQuestion("query", [], "whole vault", "");

        expect(rerank).not.toHaveBeenCalled();
        expect(answer.sources.map((source) => source.filePath)).toEqual(["notes/first.md", "notes/second.md"]);
    });

    it("falls back to the heuristic reranker when the configured remote provider fails", async () => {
        const rerank = vi.fn(async () => { throw new Error("remote unavailable"); });
        const engine = createEngine([
            createChunk("first", "unrelated first result"),
            createChunk("second", "exact phrase appears here"),
        ], { rerank });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const answer = await engine.answerQuestion("exact phrase", [], "whole vault", "");

        expect(rerank).toHaveBeenCalledOnce();
        expect(answer.sources[0]?.filePath).toBe("notes/second.md");
        expect(consoleError).toHaveBeenCalledWith(
            "[VaultCoach] 远程 rerank 失败，将回退到启发式 rerank。",
            expect.any(Error),
        );
        consoleError.mockRestore();
    });

    it("does not call the provider when retrieval returns no candidates", async () => {
        const rerank = vi.fn(async () => []);
        const engine = createEngine([], { rerank });

        const answer = await engine.answerQuestion("query", [], "whole vault", "");

        expect(rerank).not.toHaveBeenCalled();
        expect(answer.sources).toEqual([]);
    });
});

function createEngine(
    chunks: IndexedChunk[],
    rerankProvider: RerankProvider,
    settingOverrides: Partial<ReturnType<typeof createDefaultSettings>> = {},
): AdvancedRagEngine {
    const documentIndex: DocumentIndexReader = {
        isReady: () => true,
        getStats: () => ({
            fileCount: chunks.length,
            chunkCount: chunks.length,
            totalCharacters: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
            lastIndexedAt: 1,
            scopeDescription: "whole vault",
        }),
        getAllChunks: () => chunks,
        getChunkById: (id) => chunks.find((chunk) => chunk.id === id) ?? null,
        getChunksByIds: (ids) => chunks.filter((chunk) => ids.includes(chunk.id)),
        getChunksByFilePath: (filePath) => chunks.filter((chunk) => chunk.filePath === filePath),
        getFileRecords: () => [],
        getFileRecord: () => null,
        readDocumentText: async (documentId) => chunks.find((chunk) => chunk.documentId === documentId)?.text ?? "",
        searchKeyword: () => chunks.map((chunk, index) => ({
            chunk,
            score: chunks.length - index,
            matchedTokens: [],
        })),
    };
    const settings = {
        ...createDefaultSettings(),
        enableQueryRewrite: false,
        retrievalPreference: "keyword" as const,
        rerankBaseUrl: "http://127.0.0.1:11435",
        rerankModel: "test-reranker",
        answerSourceLimit: 10,
        ...settingOverrides,
    };
    return new AdvancedRagEngine(documentIndex, createVectorStore(), () => settings, () => "keyword", {
        embeddingProvider: createEmbeddingProvider(),
        rerankProvider,
        queryRewrite: {
            rewriteQuery: async ({ originalQuery }) => ({ originalQuery, rewrittenQuery: originalQuery, useRewrite: false }),
        },
        memoryExtraction: { extractMemoryStatements: async () => [] },
        chatProvider: {
            rewriteQuery: async (originalQuery) => ({ originalQuery, rewrittenQuery: originalQuery, useRewrite: false }),
            extractMemoryStatements: async () => [],
            generateMarkdownAnswer: async () => "answer",
            generateJsonAnswer: async () => "{}",
            streamMarkdownAnswer: async () => "answer",
        },
    });
}

function createChunk(id: string, text: string): IndexedChunk {
    return {
        id,
        documentId: `document-${id}`,
        documentType: "markdown",
        filePath: `notes/${id}.md`,
        fileName: `${id}.md`,
        headingPath: [id],
        primaryHeading: id,
        text,
        searchableText: text,
        locator: { type: "markdown", filePath: `notes/${id}.md`, heading: id },
        contentKind: "native-text",
    };
}

function createEmbeddingProvider(): EmbeddingProvider {
    return {
        id: "ollama",
        describe: () => ({
            providerId: "ollama",
            endpointIdentity: "http://localhost:11434",
            model: "unused",
            revision: "unverified",
            modelDtype: "server-managed",
            outputDtype: "float32",
            pooling: "server-managed",
            normalization: "server-managed",
            preprocessing: { document: "identity", query: "identity", graph: "identity" },
            implementationVersion: 1,
        }),
        embed: async () => { throw new Error("Embedding must not be used in keyword mode."); },
    };
}

function createVectorStore(): VectorStore {
    return {
        initialize: async () => undefined,
        replaceAll: async () => ({ backend: "embedded-exact", vectorCount: 0, dimension: null, persistedBytes: 0, loadedBytes: 0, lastUpdatedAt: null }),
        upsert: async () => undefined,
        remove: async () => undefined,
        search: async () => [],
        inspect: async () => ({
            status: "absent",
            fingerprint: null,
            stats: { backend: "embedded-exact", vectorCount: 0, dimension: null, persistedBytes: 0, loadedBytes: 0, lastUpdatedAt: null },
        }),
        clear: async () => undefined,
        getStats: async () => ({ backend: "embedded-exact", vectorCount: 0, dimension: null, persistedBytes: 0, loadedBytes: 0, lastUpdatedAt: null }),
        close: async () => undefined,
    };
}
