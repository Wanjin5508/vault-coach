import { isUndirectedRelation } from "../semantic-graph/concept-candidate-fingerprint";
import { compareLearningGraphEdges, compareLearningGraphNodes } from "./learning-graph-id";
import type { SemanticRelationType } from "../semantic-graph/semantic-graph-types";
import type {
    LearningGraphIntegrityIssue,
    LearningGraphIntegrityReport,
    LearningGraphProjection,
} from "./learning-graph-types";

/** Pure validation for the bounded M2/M3 read model. */
export class LearningGraphIntegrityService {
    check(projection: LearningGraphProjection): LearningGraphIntegrityReport {
        const issues: LearningGraphIntegrityIssue[] = [];
        const nodeIds = new Set<string>();
        for (const node of projection.nodes) {
            if (nodeIds.has(node.id)) {
                issues.push({ code: "duplicate-node-id", message: `Duplicate learning graph node: ${node.id}.`, nodeId: node.id });
            }
            nodeIds.add(node.id);
            if (node.evidence.some((evidence) => evidence.kind === "concept-evidence" && !evidence.sectionId)) {
                issues.push({ code: "invalid-evidence", message: `Concept node lacks a Section evidence reference: ${node.id}.`, nodeId: node.id });
            }
        }
        const edgeIds = new Set<string>();
        for (const edge of projection.edges) {
            if (edgeIds.has(edge.id)) {
                issues.push({ code: "duplicate-edge-id", message: `Duplicate learning graph edge: ${edge.id}.`, edgeId: edge.id });
            }
            edgeIds.add(edge.id);
            if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
                issues.push({ code: "missing-edge-endpoint", message: `Learning graph edge has a missing endpoint: ${edge.id}.`, edgeId: edge.id });
            }
            if (edge.origin !== "structural" && edge.directed === isUndirectedRelation(edge.type as SemanticRelationType)) {
                issues.push({ code: "invalid-relation-direction", message: `Learning graph direction is invalid: ${edge.id}.`, edgeId: edge.id });
            }
            if (edge.evidence.length === 0 && edge.origin !== "user") {
                issues.push({ code: "invalid-evidence", message: `Learning graph edge lacks evidence: ${edge.id}.`, edgeId: edge.id });
            }
        }
        if (!isSorted(projection.nodes, compareLearningGraphNodes) || !isSorted(projection.edges, compareLearningGraphEdges)) {
            issues.push({ code: "unsorted-projection", message: "Learning graph projection is not canonically sorted." });
        }
        return { valid: issues.length === 0, issues };
    }
}

function isSorted<T>(items: readonly T[], compare: (left: T, right: T) => number): boolean {
    return items.every((item, index) => index === 0 || compare(items[index - 1]!, item) <= 0);
}
