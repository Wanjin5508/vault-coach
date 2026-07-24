import { describe, expect, it } from "vitest";
import { createGraphEdgeId, createSectionNodeId } from "../../../src/domain/graph/graph-id";
import { GraphQueryService } from "../../../src/domain/graph/graph-query-service";
import { GRAPH_SNAPSHOT_SCHEMA_VERSION } from "../../../src/domain/graph/graph-types";
import type {
    DocumentGraphNode,
    GraphSnapshotV1,
    KnowledgeGraphEdge,
    SectionGraphNode,
    TagGraphNode,
} from "../../../src/domain/graph/graph-types";

describe("GraphQueryService", () => {
    it("finds deterministic graph facts by every supported key without leaking mutable references", () => {
        const snapshot = createSnapshot();
        const queries = new GraphQueryService();
        const overviewId = "markdown:notes/overview.md";
        const linkId = createGraphEdgeId("links_to", overviewId, "markdown:notes/details.md");

        const node = queries.getNode(snapshot, overviewId);
        const documentNodes = queries.findNodesByDocumentPath(snapshot, "notes/../notes/overview.md");
        const adjacentEdges = queries.findEdgesForNode(snapshot, overviewId);
        const sourceEdges = queries.findEdgesBySourceFile(snapshot, "notes/./overview.md");
        const sources = queries.getEdgeSources(snapshot, linkId);
        if (!node || node.type !== "document" || documentNodes[1]?.type !== "section" || !sources[0]) {
            throw new Error("Expected deterministic graph query results.");
        }

        node.title = "Mutated";
        documentNodes[1].headingPath.push("mutated");
        adjacentEdges[0]?.sources[0]?.chunkIds.push("mutated");
        sources[0].chunkIds.push("mutated");

        expect(documentNodes.map((candidate) => candidate.type)).toEqual(["document", "section"]);
        expect(adjacentEdges.map((edge) => edge.type)).toEqual(["links_to", "tagged_with"]);
        expect(sourceEdges.map((edge) => edge.id)).toEqual(adjacentEdges.map((edge) => edge.id));
        expect(queries.getNode(snapshot, overviewId)).toMatchObject({ title: "overview" });
        expect(queries.findNodesByDocumentPath(snapshot, "notes/overview.md")[1]).toMatchObject({
            headingPath: ["Overview"],
        });
        expect(queries.getEdgeSources(snapshot, linkId)).toEqual([
            expect.objectContaining({ chunkIds: ["overview-link"] }),
        ]);
        expect(queries.getNode(snapshot, "missing")).toBeNull();
        expect(queries.findEdgesForNode(snapshot, "missing")).toEqual([]);
        expect(queries.getEdgeSources(snapshot, "missing")).toEqual([]);
    });
});

function createSnapshot(): GraphSnapshotV1 {
    const details: DocumentGraphNode = {
        id: "markdown:notes/details.md",
        type: "document",
        documentId: "markdown:notes/details.md",
        filePath: "notes/details.md",
        documentType: "markdown",
        title: "details",
        contentHash: "details",
        modifiedAt: 1,
    };
    const overview: DocumentGraphNode = {
        id: "markdown:notes/overview.md",
        type: "document",
        documentId: "markdown:notes/overview.md",
        filePath: "notes/overview.md",
        documentType: "markdown",
        title: "overview",
        contentHash: "overview",
        modifiedAt: 2,
    };
    const section: SectionGraphNode = {
        id: createSectionNodeId(overview.documentId, ["Overview"], 0),
        type: "section",
        documentId: overview.documentId,
        filePath: overview.filePath,
        headingPath: ["Overview"],
        occurrence: 0,
        chunkIds: ["overview-heading"],
        locator: { type: "markdown", filePath: overview.filePath, heading: "Overview" },
    };
    const tag: TagGraphNode = {
        id: "tag:retrieval",
        type: "tag",
        normalizedName: "retrieval",
        displayName: "retrieval",
    };
    const link: KnowledgeGraphEdge = {
        id: createGraphEdgeId("links_to", overview.id, details.id),
        sourceNodeId: overview.id,
        targetNodeId: details.id,
        type: "links_to",
        confidence: 0.95,
        origin: "obsidian-link",
        sources: [{
            sourceFilePath: overview.filePath,
            sourceDocumentId: overview.documentId,
            sourceKind: "obsidian-link",
            targetFilePath: details.filePath,
            chunkIds: ["overview-link"],
        }],
    };
    const taggedWith: KnowledgeGraphEdge = {
        id: createGraphEdgeId("tagged_with", overview.id, tag.id),
        sourceNodeId: overview.id,
        targetNodeId: tag.id,
        type: "tagged_with",
        confidence: 0.8,
        origin: "obsidian-tag",
        sources: [{
            sourceFilePath: overview.filePath,
            sourceDocumentId: overview.documentId,
            sourceKind: "obsidian-tag",
            chunkIds: ["overview-tag"],
        }],
    };

    return {
        schemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
        nodes: [details, overview, section, tag],
        edges: [link, taggedWith],
        stats: { documentCount: 2, sectionCount: 1, tagCount: 1, edgeCount: 2 },
    };
}
