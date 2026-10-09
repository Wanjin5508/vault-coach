import { describe, expect, it } from "vitest";
import { assessGraphCapacity, LITE_SEMANTIC_AUTO_WINDOW_LIMIT, LITE_SEMANTIC_MANUAL_WINDOW_LIMIT } from "../../../src/domain/graph-capacity/graph-capacity-assessment";
import type { GraphCapacityInput } from "../../../src/domain/graph-capacity/graph-capacity-types";

describe("assessGraphCapacity", () => {
    it("publishes the Lite semantic window budgets", () => {
        expect(LITE_SEMANTIC_AUTO_WINDOW_LIMIT).toBe(400);
        expect(LITE_SEMANTIC_MANUAL_WINDOW_LIMIT).toBe(650);
    });

    it("keeps exact threshold values local and makes warning-level auto sync opt out", () => {
        expect(assessGraphCapacity(input({ semanticInputCount: LITE_SEMANTIC_AUTO_WINDOW_LIMIT }))).toMatchObject({
            level: "local",
            allowManualSemanticBuild: true,
            allowAutomaticSemanticSync: true,
        });
        expect(assessGraphCapacity(input({ semanticInputCount: LITE_SEMANTIC_AUTO_WINDOW_LIMIT + 1 }))).toMatchObject({
            level: "warning",
            allowManualSemanticBuild: true,
            allowAutomaticSemanticSync: false,
            reasons: [expect.objectContaining({ metric: "semantic-input-count", threshold: LITE_SEMANTIC_AUTO_WINDOW_LIMIT })],
        });
    });

    it("uses semantic window count as the local-build gate", () => {
        expect(assessGraphCapacity(input({ semanticInputCount: LITE_SEMANTIC_MANUAL_WINDOW_LIMIT }))).toMatchObject({
            level: "warning",
            allowManualSemanticBuild: true,
        });
        expect(assessGraphCapacity(input({ semanticInputCount: LITE_SEMANTIC_MANUAL_WINDOW_LIMIT + 1 }))).toMatchObject({
            level: "service-required",
            allowManualSemanticBuild: false,
            allowAutomaticSemanticSync: false,
        });
        const assessment = assessGraphCapacity(input({ conceptCount: 10_001, semanticInputCount: LITE_SEMANTIC_AUTO_WINDOW_LIMIT + 1 }));
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
