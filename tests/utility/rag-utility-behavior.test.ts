import { describe, expect, it, vi } from "vitest";
import { GuardedUtilityProvider } from "../../src/app/utility/guarded-utility-provider";
import { createDefaultSettings } from "../../src/app/config/settings-defaults";
import type { ChatMessage } from "../../src/app/chat/chat-types";
import type { DocumentIndexReader } from "../../src/domain/documents/document-index-reader";
import type { IndexedChunk } from "../../src/domain/documents/document-types";
import type { EmbeddingProvider } from "../../src/domain/embedding/embedding-provider";
import type { VectorStore } from "../../src/domain/retrieval/retrieval-types";
import type { MemoryExtractionRequest } from "../../src/domain/utility/memory-extraction-port";
import type { QueryRewriteRequest } from "../../src/domain/utility/query-rewrite-port";
import { AdvancedRagEngine } from "../../src/rag-engine";

describe("AdvancedRagEngine utility compatibility", () => {
    it("preserves rewrite inputs and uses the validated rewritten query for retrieval", async () => {
        let rewriteRequest: QueryRewriteRequest | null = null;
        const searchKeyword = vi.fn(() => [createKeywordHit()]);
        const utility = new GuardedUtilityProvider(
            {
                rewriteQuery: async (request) => {
                    rewriteRequest = request;
                    return {
                        originalQuery: request.originalQuery,
                        rewrittenQuery: "rewritten retrieval query",
                        useRewrite: true,
                    };
                },
            },
            { extractMemoryStatements: async () => [] },
        );
        const engine = createEngine(utility, utility, searchKeyword);

        const answer = await engine.answerQuestion("original question", createMessages(), "selected folder", "");

        expect(rewriteRequest).toEqual({
            originalQuery: "original question",
            conversationContext: "用户：previous question\n助手：previous answer",
            scopeDescription: "selected folder",
        });
        expect(searchKeyword).toHaveBeenCalledWith("rewritten retrieval query", expect.any(Number));
        expect(answer.queryRewrite).toEqual({
            originalQuery: "original question",
            rewrittenQuery: "rewritten retrieval query",
            useRewrite: true,
        });
    });

    it("uses the original query when rewrite fails without blocking retrieval", async () => {
        const searchKeyword = vi.fn(() => [createKeywordHit()]);
        const utility = new GuardedUtilityProvider(
            { rewriteQuery: async () => { throw new Error("rewrite unavailable"); } },
            { extractMemoryStatements: async () => [] },
        );
        const engine = createEngine(utility, utility, searchKeyword);

        const answer = await engine.answerQuestion("original question", [], "whole vault", "");

        expect(searchKeyword).toHaveBeenCalledWith("original question", expect.any(Number));
        expect(answer.queryRewrite).toEqual({
            originalQuery: "original question",
            rewrittenQuery: "original question",
            useRewrite: false,
        });
    });

    it("preserves memory extraction roles and returns an isolated empty result on failure", async () => {
        let memoryRequest: MemoryExtractionRequest | null = null;
        const memoryExtraction = {
            extractMemoryStatements: async (request: MemoryExtractionRequest) => {
                memoryRequest = request;
                throw new Error("memory unavailable");
            },
        };
        const utility = new GuardedUtilityProvider(
            { rewriteQuery: async ({ originalQuery }) => ({ originalQuery, rewrittenQuery: originalQuery, useRewrite: false }) },
            memoryExtraction,
        );
        const engine = createEngine(utility, utility, vi.fn(() => [createKeywordHit()]));

        await expect(engine.extractMemoryStatements("latest user", "latest assistant", createMessages()))
            .resolves.toEqual([]);
        expect(memoryRequest).toEqual({
            conversationContext: "用户：previous question\n助手：previous answer",
            latestUserText: "latest user",
            latestAssistantText: "latest assistant",
        });
    });
});

function createEngine(
    queryRewrite: ConstructorParameters<typeof AdvancedRagEngine>[4]["queryRewrite"],
    memoryExtraction: ConstructorParameters<typeof AdvancedRagEngine>[4]["memoryExtraction"],
    searchKeyword: DocumentIndexReader["searchKeyword"],
): AdvancedRagEngine {
    const chunk = createChunk();
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
        searchKeyword,
    };
    const settings = {
        ...createDefaultSettings(),
        retrievalPreference: "keyword" as const,
        enableRerank: false,
    };
    return new AdvancedRagEngine(documentIndex, createVectorStore(), () => settings, () => "keyword", {
        queryRewrite,
        memoryExtraction,
        embeddingProvider: createEmbeddingProvider(),
        rerankProvider: { rerank: async () => [] },
        chatProvider: {
            rewriteQuery: async (originalQuery) => ({ originalQuery, rewrittenQuery: originalQuery, useRewrite: false }),
            extractMemoryStatements: async () => [],
            generateMarkdownAnswer: async () => "answer",
            generateJsonAnswer: async () => "{}",
            streamMarkdownAnswer: async () => "answer",
        },
    });
}

function createMessages(): ChatMessage[] {
    return [
        { role: "user", text: "previous question", createdAt: 1 },
        { role: "assistant", text: "previous answer", createdAt: 2 },
    ];
}

function createChunk(): IndexedChunk {
    return {
        id: "chunk-1",
        documentId: "document-1",
        documentType: "markdown",
        filePath: "notes/a.md",
        fileName: "a.md",
        headingPath: ["A"],
        primaryHeading: "A",
        text: "retrieved content",
        searchableText: "retrieved content",
        locator: { type: "markdown", filePath: "notes/a.md", heading: "A" },
        contentKind: "native-text",
    };
}

function createKeywordHit() {
    return { chunk: createChunk(), score: 1, matchedTokens: ["query"] };
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
