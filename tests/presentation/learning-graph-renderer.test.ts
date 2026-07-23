import { describe, expect, it } from "vitest";
import { createLearningGraphForceLayout, learningGraphNodeRadiusForDegree, learningGraphZoomMultiplier } from "../../src/presentation/components/learning-graph-renderer";
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
        expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
        expect(xSpan).toBeGreaterThan(420);
        expect(ySpan).toBeGreaterThan(300);
        expect(minimumDistance(points)).toBeGreaterThan(42);
    });

    it("reserves an expanded local neighbourhood around high-degree hubs", () => {
        const nodes = Array.from({ length: 28 }, (_value, index) => node(index));
        const edges = nodes.slice(1).map((target, index) => edge(nodes[0]!.id, target.id, index));
        const layout = createLearningGraphForceLayout(nodes, edges);
        const hub = layout.get(nodes[0]!.id);
        if (!hub) throw new Error("Expected hub position.");
        const nearestLeaf = Math.min(...nodes.slice(1).map((leaf) => {
            const point = layout.get(leaf.id);
            return point ? Math.hypot(point.x - hub.x, point.y - hub.y) : 0;
        }));

        expect(nearestLeaf).toBeGreaterThan(92);
    });

    it("keeps connected hub communities locally distinct inside one graph cloud", () => {
        const nodes = Array.from({ length: 16 }, (_value, index) => node(index));
        const edges = [
            ...nodes.slice(1, 8).map((target, index) => edge(nodes[0]!.id, target.id, index)),
            ...nodes.slice(9).map((target, index) => edge(nodes[8]!.id, target.id, index + 7)),
            edge(nodes[0]!.id, nodes[8]!.id, 14),
        ];
        const layout = createLearningGraphForceLayout(nodes, edges);
        const firstHub = layout.get(nodes[0]!.id);
        const secondHub = layout.get(nodes[8]!.id);
        if (!firstHub || !secondHub) throw new Error("Expected both galaxy hubs.");

        const hubDistance = Math.hypot(firstHub.x - secondHub.x, firstHub.y - secondHub.y);
        const firstLeaf = layout.get(nodes[1]!.id);
        if (!firstLeaf) throw new Error("Expected first galaxy leaf.");
        expect(hubDistance).toBeGreaterThan(155);
        expect(Math.hypot(firstLeaf.x - firstHub.x, firstLeaf.y - firstHub.y))
            .toBeLessThan(Math.hypot(firstLeaf.x - secondHub.x, firstLeaf.y - secondHub.y));
    });

    it("scales visual node radius monotonically with degree", () => {
        expect(learningGraphNodeRadiusForDegree(0)).toBeLessThan(learningGraphNodeRadiusForDegree(4));
        expect(learningGraphNodeRadiusForDegree(4)).toBeLessThan(learningGraphNodeRadiusForDegree(25));
        expect(learningGraphNodeRadiusForDegree(25) - learningGraphNodeRadiusForDegree(0)).toBeGreaterThan(30);
    });

    it("uses gradual delta-based zoom suitable for a trackpad", () => {
        expect(learningGraphZoomMultiplier(1)).toBeGreaterThan(0.998);
        expect(learningGraphZoomMultiplier(40)).toBeGreaterThan(0.95);
        expect(learningGraphZoomMultiplier(40)).toBeLessThan(0.97);
        expect(learningGraphZoomMultiplier(-40)).toBeGreaterThan(1);
        expect(learningGraphZoomMultiplier(3, 1)).toBeLessThan(1);
    });
});

function minimumDistance(points: readonly { x: number; y: number }[]): number {
    let minimum = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length; index += 1) {
        for (let next = index + 1; next < points.length; next += 1) {
            const left = points[index];
            const right = points[next];
            if (!left || !right) continue;
            minimum = Math.min(minimum, Math.hypot(left.x - right.x, left.y - right.y));
        }
    }
    return minimum;
}

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
        trust: "confirmed",
        confidence: 1,
        evidence: [],
    };
}
