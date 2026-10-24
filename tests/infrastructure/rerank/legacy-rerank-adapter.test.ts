import { describe, expect, it } from "vitest";
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
});
