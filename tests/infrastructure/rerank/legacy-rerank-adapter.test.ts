import { describe, expect, it, vi } from "vitest";
import { LegacyRerankAdapter } from "../../../src/infrastructure/rerank/legacy-rerank-adapter";

describe("LegacyRerankAdapter", () => {
    it("maps local response indexes to stable candidate IDs and rejects invalid duplicate entries", async () => {
        const adapter = new LegacyRerankAdapter({
            rerankDocuments: async () => [
                { index: 1, relevance_score: 0.9 },
                { index: 1, relevance_score: 0.1 },
                { index: 8, relevance_score: 1 },
                { index: 0, relevance_score: Number.NaN },
            ],
        });

        await expect(adapter.rerank({
            query: "query",
            candidates: [{ id: "first", text: "A" }, { id: "second", text: "B" }],
        })).resolves.toEqual([{ candidateId: "second", score: 0.9 }]);
    });

    it("does not call the legacy service for an empty candidate batch", async () => {
        const rerankDocuments = vi.fn(async () => []);
        const adapter = new LegacyRerankAdapter({ rerankDocuments });

        await expect(adapter.rerank({ query: "query", candidates: [] })).resolves.toEqual([]);

        expect(rerankDocuments).not.toHaveBeenCalled();
    });

    it("rejects duplicate stable candidate IDs before calling the legacy service", async () => {
        const rerankDocuments = vi.fn(async () => []);
        const adapter = new LegacyRerankAdapter({ rerankDocuments });

        await expect(adapter.rerank({
            query: "query",
            candidates: [{ id: "same", text: "A" }, { id: "same", text: "B" }],
        })).rejects.toThrow("Duplicate rerank candidate ID: same");

        expect(rerankDocuments).not.toHaveBeenCalled();
    });

    it("honors cancellation before and after the legacy request", async () => {
        const before = new AbortController();
        before.abort();
        const rerankDocuments = vi.fn(async () => [{ index: 0, relevance_score: 1 }]);
        const adapter = new LegacyRerankAdapter({ rerankDocuments });

        await expect(adapter.rerank({
            query: "query",
            candidates: [{ id: "first", text: "A" }],
            signal: before.signal,
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(rerankDocuments).not.toHaveBeenCalled();

        const after = new AbortController();
        const abortingAdapter = new LegacyRerankAdapter({
            rerankDocuments: async () => {
                after.abort();
                return [{ index: 0, relevance_score: 1 }];
            },
        });
        await expect(abortingAdapter.rerank({
            query: "query",
            candidates: [{ id: "first", text: "A" }],
            signal: after.signal,
        })).rejects.toMatchObject({ name: "AbortError" });
    });
});
