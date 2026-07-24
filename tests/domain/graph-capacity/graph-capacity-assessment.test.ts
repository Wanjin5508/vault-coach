import { describe, expect, it } from "vitest";
import { assessGraphCapacity } from "../../../src/domain/graph-capacity/graph-capacity-assessment";
import type { GraphCapacityInput } from "../../../src/domain/graph-capacity/graph-capacity-types";

describe("assessGraphCapacity", () => {
    it("keeps exact threshold values local and makes warning-level auto sync opt out", () => {
        expect(assessGraphCapacity(input({ chunkCount: 8_000 }))).toMatchObject({
            level: "local",
            allowManualSemanticBuild: true,
            allowAutomaticSemanticSync: true,
        });
        expect(assessGraphCapacity(input({ chunkCount: 8_001 }))).toMatchObject({
            level: "warning",
            allowManualSemanticBuild: true,
            allowAutomaticSemanticSync: false,
            reasons: [expect.objectContaining({ metric: "chunk-count", threshold: 8_000 })],
        });
    });

    it("uses the highest triggered level across independent local metrics", () => {
        expect(assessGraphCapacity(input({ sectionCount: 2_501 }))).toMatchObject({
            level: "service-preferred",
            allowManualSemanticBuild: false,
            allowAutomaticSemanticSync: false,
        });
        const assessment = assessGraphCapacity(input({ conceptCount: 10_001, chunkCount: 8_001 }));
        expect(assessment).toMatchObject({
            level: "service-required",
            allowManualSemanticBuild: false,
        });
        expect(assessment.reasons.some((reason) => reason.metric === "concept-count" && reason.level === "service-required")).toBe(true);
        expect(assessment.reasons.some((reason) => reason.metric === "chunk-count" && reason.level === "warning")).toBe(true);
    });

    it("estimates Float32 vector memory only when both cardinality and dimension are known", () => {
        expect(assessGraphCapacity(input({ vectorCount: 40_000, vectorDimension: 1_024 }))).toMatchObject({
            rawVectorBytes: 163_840_000,
            level: "service-preferred",
        });
        expect(assessGraphCapacity(input({ vectorCount: 40_000, vectorDimension: null }))).toMatchObject({
            rawVectorBytes: null,
            hasUnknownMetrics: true,
        });
    });
});

function input(overrides: Partial<GraphCapacityInput> = {}): GraphCapacityInput {
    return {
        fileCount: 1,
        chunkCount: 1,
        documentCount: 1,
        sectionCount: 1,
        structuralEdgeCount: 0,
        indexedTextBytes: 1,
        extractionCount: 0,
        conceptCount: 0,
        candidateCount: 0,
        effectiveRelationCount: 0,
        embeddingCount: 0,
        vectorCount: 0,
        vectorDimension: 0,
        ...overrides,
    };
}
