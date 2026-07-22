import type { LearningGraphEdge, LearningGraphNode } from "./learning-graph-types";

export function createLearningGraphSemanticEdgeId(relationId: string): string {
    return `learning:semantic:${relationId.trim()}`;
}

export function createLearningGraphStructuralEdgeId(edgeId: string): string {
    return `learning:structural:${edgeId.trim()}`;
}

export function compareLearningGraphNodes(left: Pick<LearningGraphNode, "id">, right: Pick<LearningGraphNode, "id">): number {
    return left.id.localeCompare(right.id);
}

export function compareLearningGraphEdges(left: Pick<LearningGraphEdge, "id">, right: Pick<LearningGraphEdge, "id">): number {
    return left.id.localeCompare(right.id);
}
