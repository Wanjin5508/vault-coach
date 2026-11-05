import { describe, expect, it, vi } from "vitest";
import { BuiltinRerankProvider } from "../../../src/infrastructure/rerank/builtin-rerank-provider";
import type { LocalAIRerankerRuntimePort } from "../../../src/domain/local-ai/local-ai-types";

describe("BuiltinRerankProvider", () => {
    it("forwards stable candidate IDs and cancellation to the shared runtime", async () => {
        const rerank = vi.fn(async () => ({
            scores: [{ candidateId: "second", score: 0.8 }, { candidateId: "first", score: 0.2 }],
            latencyMs: 10,
            truncatedCandidateCount: 1,
        }));
        const provider = new BuiltinRerankProvider(createRuntime(rerank));
        const controller = new AbortController();

        await expect(provider.rerank({
            query: "query",
            candidates: [{ id: "first", text: "A" }, { id: "second", text: "B" }],
            signal: controller.signal,
        })).resolves.toEqual([{ candidateId: "second", score: 0.8 }, { candidateId: "first", score: 0.2 }]);
        expect(rerank).toHaveBeenCalledWith({
            query: "query",
            candidates: [{ id: "first", text: "A" }, { id: "second", text: "B" }],
            signal: controller.signal,
        });
    });

    it("returns an empty result without preparing or invoking the runtime", async () => {
        const rerank = vi.fn();
        const provider = new BuiltinRerankProvider(createRuntime(rerank));

        await expect(provider.rerank({ query: "query", candidates: [] })).resolves.toEqual([]);
        expect(rerank).not.toHaveBeenCalled();
    });
});

function createRuntime(rerank: LocalAIRerankerRuntimePort["rerank"]): LocalAIRerankerRuntimePort {
    return {
        getRerankerStatus: () => ({
            role: "reranker",
            phase: "ready",
            progress: 1,
            message: null,
            cached: true,
            backend: "wasm",
        }),
        prepareReranker: async () => undefined,
        rerank,
        clearReranker: async () => undefined,
    };
}
