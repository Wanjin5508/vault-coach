import { isUndirectedRelation } from "../../domain/semantic-graph/concept-candidate-fingerprint";
import type { GraphSnapshotV1, KnowledgeGraphNode } from "../../domain/graph/graph-types";
import type { ConceptEvidenceRef, EffectiveSemanticGraph, EffectiveSemanticRelation, SemanticConcept } from "../../domain/semantic-graph/semantic-graph-types";
import { createLearningGraphSemanticEdgeId, createLearningGraphStructuralEdgeId, compareLearningGraphEdges, compareLearningGraphNodes } from "../../domain/learning-graph/learning-graph-id";
import type { LearningGraphConceptEvidence, LearningGraphEdge, LearningGraphEvidence, LearningGraphNode } from "../../domain/learning-graph/learning-graph-types";

export interface LearningGraphFacts {
    nodes: LearningGraphNode[];
    edges: LearningGraphEdge[];
}

/** Converts M2 structural facts and M3 effective facts into one read-only graph. */
export class LearningGraphProjectionService {
    build(
        snapshot: GraphSnapshotV1,
        semantic: EffectiveSemanticGraph,
        autoRelations: readonly EffectiveSemanticRelation[],
        includeStructuralContext: boolean,
    ): LearningGraphFacts {
        const conceptNodes = semantic.concepts.map(toConceptNode);
        const semanticEdges = [
            ...semantic.relations.map((relation) => toSemanticEdge(relation, "confirmed")),
            ...autoRelations.map((relation) => toSemanticEdge(relation, "automatic")),
        ];
        if (!includeStructuralContext) {
            return { nodes: conceptNodes.sort(compareLearningGraphNodes), edges: semanticEdges.sort(compareLearningGraphEdges) };
        }

        const structuralNodeIds = collectStructuralContextIds(snapshot, semantic.concepts);
        const structuralNodes = snapshot.nodes
            .filter((node) => structuralNodeIds.has(node.id))
            .map(toStructuralNode);
        const structuralEdges = snapshot.edges
            .filter((edge) => structuralNodeIds.has(edge.sourceNodeId) && structuralNodeIds.has(edge.targetNodeId))
            .map((edge): LearningGraphEdge => ({
                id: createLearningGraphStructuralEdgeId(edge.id),
                type: edge.type,
                sourceNodeId: edge.sourceNodeId,
                targetNodeId: edge.targetNodeId,
                directed: true,
                origin: "structural",
                trust: "structural",
                confidence: edge.confidence,
                evidence: edge.sources.map((source) => ({ kind: "structural-evidence", source: { ...source, chunkIds: [...source.chunkIds] } })),
            }));
        return {
            nodes: [...conceptNodes, ...structuralNodes].sort(compareLearningGraphNodes),
            edges: [...semanticEdges, ...structuralEdges].sort(compareLearningGraphEdges),
        };
    }
}

function toConceptNode(concept: SemanticConcept): LearningGraphNode {
    const evidence = concept.evidence.map(toConceptEvidence);
    return {
        id: concept.id,
        kind: "concept",
        label: concept.displayName,
        aliases: [...concept.aliases].sort((left, right) => left.localeCompare(right)),
        description: concept.description,
        sourcePaths: uniqueSorted(evidence.map((item) => pathFromLocator(item.locator))),
        evidence,
    };
}

function toSemanticEdge(relation: EffectiveSemanticRelation, trust: "confirmed" | "automatic"): LearningGraphEdge {
    const evidence: LearningGraphEvidence[] = relation.evidence.map(toConceptEvidence);
    if (relation.origin === "user" && relation.decisionId) {
        evidence.push({ kind: "user-decision", decisionId: relation.decisionId });
    }
    return {
        id: createLearningGraphSemanticEdgeId(relation.id),
        type: relation.type,
        sourceNodeId: relation.sourceConceptId,
        targetNodeId: relation.targetConceptId,
        directed: !isUndirectedRelation(relation.type),
        origin: relation.origin === "user" ? "user" : "semantic",
        trust,
        confidence: relation.confidence,
        evidence,
    };
}

function toConceptEvidence(evidence: ConceptEvidenceRef): LearningGraphConceptEvidence {
    return {
        kind: "concept-evidence",
        sectionId: evidence.sectionId,
        chunkId: evidence.chunkId,
        locator: { ...evidence.locator },
        excerptId: evidence.excerptId,
        textPreview: evidence.textPreview,
    };
}

function collectStructuralContextIds(snapshot: GraphSnapshotV1, concepts: readonly SemanticConcept[]): Set<string> {
    const nodeIds = new Set<string>(concepts.flatMap((concept) => concept.evidence.map((evidence) => evidence.sectionId)));
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    for (const nodeId of Array.from(nodeIds)) {
        const section = byId.get(nodeId);
        if (section?.type === "section") nodeIds.add(section.documentId);
    }
    // Include a Section's containing hierarchy, without walking the full graph.
    const parentsByTarget = new Map<string, string[]>();
    for (const edge of snapshot.edges) {
        if (edge.type !== "contains") continue;
        const parents = parentsByTarget.get(edge.targetNodeId) ?? [];
        parents.push(edge.sourceNodeId);
        parentsByTarget.set(edge.targetNodeId, parents);
    }
    const queue = Array.from(nodeIds);
    while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId) continue;
        for (const parentId of parentsByTarget.get(nodeId) ?? []) {
            if (nodeIds.has(parentId)) continue;
            nodeIds.add(parentId);
            queue.push(parentId);
        }
    }
    // Tags are source context for the documents already reached above.
    for (const edge of snapshot.edges) {
        if (edge.type === "tagged_with" && nodeIds.has(edge.sourceNodeId)) nodeIds.add(edge.targetNodeId);
    }
    return nodeIds;
}

function toStructuralNode(node: KnowledgeGraphNode): LearningGraphNode {
    if (node.type === "document") {
        return { id: node.id, kind: "document", label: node.title, aliases: [], description: node.filePath, sourcePaths: [node.filePath], evidence: [] };
    }
    if (node.type === "section") {
        const label = node.headingPath.at(-1) ?? node.filePath;
        return {
            id: node.id,
            kind: "section",
            label,
            aliases: node.headingPath.slice(0, -1),
            description: node.headingPath.join(" › "),
            sourcePaths: [node.filePath],
            evidence: [],
        };
    }
    return { id: node.id, kind: "tag", label: `#${node.displayName}`, aliases: [], description: node.normalizedName, sourcePaths: [], evidence: [] };
}

function pathFromLocator(locator: ConceptEvidenceRef["locator"]): string {
    return locator.type === "zotero" ? "" : locator.filePath;
}

function uniqueSorted(values: readonly string[]): string[] {
    return Array.from(new Set(values.filter((value) => value.length > 0))).sort((left, right) => left.localeCompare(right));
}
