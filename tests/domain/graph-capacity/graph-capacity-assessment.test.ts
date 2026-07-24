import { describe, expect, it } from "vitest";
import { assessGraphCapacity } from "../../../src/domain/graph-capacity/graph-capacity-assessment";
import type { GraphCapacityInput } from "../../../src/domain/graph-capacity/graph-capacity-types";

describe("assessGraphCapacity", () => {
    it("keeps exact threshold values local and makes warning-level auto sync opt out", () => {
        expect(assessGraphCapacity(input({ semanticInputCount: 300 }))).toMatchObject({
            level: "local",
            allowManualSemanticBuild: true,
            allowAutomaticSemanticSync: true,
        });
        expect(assessGraphCapacity(input({ semanticInputCount: 301 }))).toMatchObject({
            level: "warning",
            allowManualSemanticBuild: true,
            allowAutomaticSemanticSync: false,
            reasons: [expect.objectContaining({ metric: "semantic-input-count", threshold: 300 })],
        });
    });

    it("uses semantic window count as the local-build gate", () => {
        expect(assessGraphCapacity(input({ semanticInputCount: 500 }))).toMatchObject({
            level: "warning",
            allowManualSemanticBuild: true,
        });
        expect(assessGraphCapacity(input({ semanticInputCount: 501 }))).toMatchObject({
            level: "service-required",
            allowManualSemanticBuild: false,
            allowAutomaticSemanticSync: false,
        });
        const assessment = assessGraphCapacity(input({ conceptCount: 10_001, semanticInputCount: 301 }));
        expect(assessment).toMatchObject({
            level: "warning",
            allowManualSemanticBuild: true,
        });
        expect(assessment.reasons.some((reason) => reason.metric === "concept-count" && reason.level === "warning")).toBe(true);
        expect(assessment.reasons.some((reason) => reason.metric === "semantic-input-count" && reason.level === "warning")).toBe(true);
    });

    it("estimates Float32 vector memory only when both cardinality and dimension are known", () => {
        expect(assessGraphCapacity(input({ vectorCount: 40_000, vectorDimension: 1_024 }))).toMatchObject({
            rawVectorBytes: 163_840_000,
            level: "warning",
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
        semanticInputCount: 1,
        semanticInputCharacters: 1,
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
