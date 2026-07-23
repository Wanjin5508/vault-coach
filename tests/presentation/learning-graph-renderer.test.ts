import { describe, expect, it } from "vitest";
import { createLearningGraphForceLayout } from "../../src/presentation/components/learning-graph-renderer";
import type { LearningGraphEdge, LearningGraphNode } from "../../src/domain/learning-graph/learning-graph-types";

describe("createLearningGraphForceLayout", () => {
    it("keeps the capped projection deterministic and distributed for an Obsidian-style graph view", () => {
        const nodes = Array.from({ length: 72 }, (_value, index) => node(index));
        const edges = nodes.slice(1).map((target, index) => edge(nodes[index]!.id, target.id, index));

        const first = createLearningGraphForceLayout(nodes, edges);
        const second = createLearningGraphForceLayout(nodes, edges);
        const points = Array.from(first.values());
        const xSpan = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
        const ySpan = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));

        expect(Array.from(first.entries())).toEqual(Array.from(second.entries()));
        expect(points).toHaveLength(72);
        expect(points.every((point) => point.x >= 21 && point.x <= 899 && point.y >= 29 && point.y <= 611)).toBe(true);
        expect(xSpan).toBeGreaterThan(420);
        expect(ySpan).toBeGreaterThan(300);
    });
});

function node(index: number): LearningGraphNode {
    return {
        id: `concept:${index.toString().padStart(3, "0")}`,
        kind: "concept",
        label: `Concept ${index}`,
        aliases: [],
        description: "test",
        sourcePaths: [],
        evidence: [],
    };
}

function edge(sourceNodeId: string, targetNodeId: string, index: number): LearningGraphEdge {
    return {
        id: `relation:${index}`,
        type: "related_to",
        sourceNodeId,
        targetNodeId,
        directed: false,
        origin: "semantic",
        confidence: 1,
        evidence: [],
    };
}
