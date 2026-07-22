import { describe, expect, it } from "vitest";
import { LearningGraphQueryService } from "../../../src/app/learning-graph/learning-graph-query-service";
import type { LearningGraphSource } from "../../../src/app/learning-graph/learning-graph-source";
import type { GraphSnapshotV1, KnowledgeGraphEdge } from "../../../src/domain/graph/graph-types";
import type { SemanticConcept } from "../../../src/domain/semantic-graph/semantic-graph-types";

describe("LearningGraphQueryService", () => {
    it("projects only effective M3 concepts and confirmed/user relations with preserved direction", () => {
        const queries = new LearningGraphQueryService(source());
        const projection = queries.getProjection();

        expect(projection.nodes.map((node) => node.id)).toEqual(["concept:alpha", "concept:beta", "concept:gamma"]);
        expect(projection.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "prerequisite_of", sourceNodeId: "concept:alpha", targetNodeId: "concept:beta", directed: true, origin: "semantic" }),
            expect.objectContaining({ type: "related_to", sourceNodeId: "concept:beta", targetNodeId: "concept:gamma", directed: false, origin: "user" }),
        ]));
        expect(projection.nodes.some((node) => node.id === "concept:pending")).toBe(false);

        projection.nodes[0]!.label = "mutated";
        expect(queries.getProjection().nodes[0]!.label).toBe("Alpha");
    });

    it("supports source context, relation filtering, bounded focus traversal, and deterministic budgets", () => {
        const queries = new LearningGraphQueryService(source());
        const contextual = queries.getProjection({ includeStructuralContext: true });
        expect(contextual.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["doc:a", "section:a", "tag:alpha"]));
        expect(contextual.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "contains", origin: "structural", directed: true }),
            expect.objectContaining({ type: "tagged_with", origin: "structural", directed: true }),
        ]));

        const filtered = queries.getProjection({ relationTypes: ["prerequisite_of"] });
        expect(filtered.edges.map((edge) => edge.type)).toEqual(["prerequisite_of"]);

        const focused = queries.getProjection({ focusNodeId: "concept:alpha", depth: 1 });
        expect(focused.nodes.map((node) => node.id)).toEqual(["concept:alpha", "concept:beta"]);
        expect(focused.edges.map((edge) => edge.type)).toEqual(["prerequisite_of"]);

        const first = queries.getProjection({ maxNodes: 2, maxEdges: 1 });
        const second = queries.getProjection({ maxNodes: 2, maxEdges: 1 });
        expect(first).toEqual(second);
        expect(first.stats).toMatchObject({ truncated: true, hiddenNodeCount: 1, hiddenEdgeCount: 1 });
    });

    it("returns an explainable unavailable projection before M2 has a snapshot", () => {
        const queries = new LearningGraphQueryService({
            getStructuralSnapshot: () => null,
            getEffectiveSemanticGraph: () => ({ concepts: [], relations: [], redirects: {}, rejectedCandidateFingerprints: [] }),
        });
        expect(queries.getProjection()).toMatchObject({ sourceReady: false, nodes: [], edges: [] });
        expect(queries.getConceptCatalog()).toMatchObject({ sourceReady: false, concepts: [] });
    });

    it("exposes an unbounded effective-concept catalog for domain computation, not renderer candidates", () => {
        const catalog = new LearningGraphQueryService(source()).getConceptCatalog();

        expect(catalog).toEqual({
            sourceReady: true,
            message: null,
            concepts: [
                { id: "concept:alpha", label: "Alpha", aliases: ["Alpha alias"], sourcePaths: ["notes/a.md"] },
                { id: "concept:beta", label: "Beta", aliases: ["Beta alias"], sourcePaths: ["notes/b.md"] },
                { id: "concept:gamma", label: "Gamma", aliases: ["Gamma alias"], sourcePaths: ["notes/b.md"] },
            ],
        });
    });
});

function source(): LearningGraphSource {
    return {
        getStructuralSnapshot: () => snapshot(),
        getEffectiveSemanticGraph: () => ({
            concepts: [concept("concept:alpha", "Alpha", "section:a", "notes/a.md"), concept("concept:beta", "Beta", "section:b", "notes/b.md"), concept("concept:gamma", "Gamma", "section:b", "notes/b.md")],
            relations: [
                {
                    id: "relation:confirmed",
                    type: "prerequisite_of",
                    sourceConceptId: "concept:alpha",
                    targetConceptId: "concept:beta",
                    confidence: 0.9,
                    origin: "model",
                    evidence: [evidence("section:a", "notes/a.md")],
                    candidateFingerprint: "candidate:confirmed",
                },
                {
                    id: "relation:user",
                    type: "related_to",
                    sourceConceptId: "concept:beta",
                    targetConceptId: "concept:gamma",
                    confidence: 1,
                    origin: "user",
                    evidence: [],
                    decisionId: "decision:user",
                },
            ],
            redirects: { "concept:merged": "concept:alpha" },
            rejectedCandidateFingerprints: ["candidate:rejected"],
        }),
    };
}

function concept(id: string, displayName: string, sectionId: string, filePath: string): SemanticConcept {
    return {
        id,
        displayName,
        normalizedName: displayName.toLowerCase(),
        aliases: [`${displayName} alias`],
        description: `${displayName} concept`,
        evidence: [evidence(sectionId, filePath)],
        sourceCandidateIds: [`candidate:${id}`],
        createdAt: 1,
        updatedAt: 1,
    };
}

function evidence(sectionId: string, filePath: string) {
    return {
        sectionId,
        chunkId: `chunk:${sectionId}`,
        locator: { type: "markdown" as const, filePath, heading: "Topic" },
        excerptId: `excerpt:${sectionId}`,
        inputHash: "hash",
        textPreview: `Evidence from ${filePath}`,
    };
}

function snapshot(): GraphSnapshotV1 {
    const edges: KnowledgeGraphEdge[] = [
        structuralEdge("contains:a", "doc:a", "section:a", "contains", "heading-structure"),
        structuralEdge("contains:b", "doc:b", "section:b", "contains", "heading-structure"),
        structuralEdge("tag:a", "doc:a", "tag:alpha", "tagged_with", "obsidian-tag"),
    ];
    return {
        schemaVersion: 1,
        nodes: [
            { id: "doc:a", type: "document", documentId: "doc:a", filePath: "notes/a.md", documentType: "markdown", title: "A", contentHash: "a", modifiedAt: 1 },
            { id: "doc:b", type: "document", documentId: "doc:b", filePath: "notes/b.md", documentType: "markdown", title: "B", contentHash: "b", modifiedAt: 1 },
            { id: "section:a", type: "section", documentId: "doc:a", filePath: "notes/a.md", headingPath: ["Topic"], occurrence: 0, chunkIds: ["chunk:section:a"], locator: { type: "markdown", filePath: "notes/a.md", heading: "Topic" } },
            { id: "section:b", type: "section", documentId: "doc:b", filePath: "notes/b.md", headingPath: ["Topic"], occurrence: 0, chunkIds: ["chunk:section:b"], locator: { type: "markdown", filePath: "notes/b.md", heading: "Topic" } },
            { id: "tag:alpha", type: "tag", normalizedName: "alpha", displayName: "alpha" },
        ],
        edges,
        stats: { documentCount: 2, sectionCount: 2, tagCount: 1, edgeCount: edges.length },
    };
}

function structuralEdge(
    id: string,
    sourceNodeId: string,
    targetNodeId: string,
    type: "contains" | "tagged_with",
    origin: "heading-structure" | "obsidian-tag",
): KnowledgeGraphEdge {
    return {
        id,
        sourceNodeId,
        targetNodeId,
        type,
        confidence: 1,
        origin,
        sources: [{ sourceFilePath: "notes/a.md", sourceDocumentId: "doc:a", sourceKind: origin, chunkIds: ["chunk:section:a"] }],
    };
}
