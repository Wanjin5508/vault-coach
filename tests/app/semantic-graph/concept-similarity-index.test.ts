import { describe, expect, it } from "vitest";
import { BoundedLshConceptSimilarityIndex } from "../../../src/app/semantic-graph/concept-similarity-index";

describe("BoundedLshConceptSimilarityIndex", () => {
    it("returns bounded approximate Top-K neighbours without an exact all-record fallback", async () => {
        const index = new BoundedLshConceptSimilarityIndex();
        await index.upsert([
            { conceptId: "concept:a", vector: [1, 0, 0, 0] },
            { conceptId: "concept:b", vector: [0.99, 0.01, 0, 0] },
            { conceptId: "concept:c", vector: [0, 1, 0, 0] },
        ]);

        const hits = await index.findNearest([1, 0, 0, 0], 1);

        expect(hits).toHaveLength(1);
        expect(hits[0]?.conceptId).toBe("concept:a");
        expect(hits[0]?.similarity).toBeCloseTo(1);
        await index.remove(["concept:a"]);
        expect((await index.findNearest([1, 0, 0, 0], 10)).some((hit) => hit.conceptId === "concept:a")).toBe(false);
    });
});
