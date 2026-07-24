import { describe, expect, it } from "vitest";
import { createForceLayout } from "../../src/presentation/components/concept-force-graph";
import type { SemanticConcept } from "../../src/domain/semantic-graph/semantic-graph-types";

describe("createForceLayout", () => {
    it("keeps the bounded local review projection distributed inside the canvas", () => {
        const concepts = Array.from({ length: 36 }, (_value, index) => concept(index));
        const edges = concepts.slice(1).map((concept, index) => ({
            sourceConceptId: concepts[index]?.id ?? "",
            targetConceptId: concept.id,
        }));

        const positions = createForceLayout(concepts, edges);
        const values = Array.from(positions.values());
        const nearestDistance = values.flatMap((left, leftIndex) => values.slice(leftIndex + 1).map((right) => {
            const dx = left.x - right.x;
            const dy = left.y - right.y;
            return Math.sqrt(dx * dx + dy * dy);
        })).reduce((minimum, distance) => Math.min(minimum, distance), Number.POSITIVE_INFINITY);

        expect(positions).toHaveLength(36);
        expect(values.every((position) => position.x >= 25 && position.x <= 535 && position.y >= 37 && position.y <= 705)).toBe(true);
        expect(nearestDistance).toBeGreaterThan(48);
    });
});

function concept(index: number): SemanticConcept {
    return {
        id: `concept:${index.toString(16).padStart(8, "0")}`,
        displayName: `Concept ${index}`,
        normalizedName: `concept ${index}`,
        aliases: [],
        description: "test",
        evidence: [{
            sectionId: "section:test",
            chunkId: `chunk:${index}`,
            locator: { type: "markdown", filePath: "test.md" },
            excerptId: "E1",
            inputHash: "hash",
            textPreview: "test",
        }],
        sourceCandidateIds: [`candidate:${index}`],
        createdAt: 1,
        updatedAt: 1,
    };
}
