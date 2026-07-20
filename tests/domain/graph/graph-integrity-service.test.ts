import { describe, expect, it } from "vitest";
import { createGraphEdgeId, createSectionNodeId } from "../../../src/domain/graph/graph-id";
import { GraphIntegrityService } from "../../../src/domain/graph/graph-integrity-service";
import { GRAPH_SNAPSHOT_SCHEMA_VERSION } from "../../../src/domain/graph/graph-types";
import type {
    DocumentGraphNode,
    GraphSnapshotV1,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    SectionGraphNode,
    TagGraphNode,
} from "../../../src/domain/graph/graph-types";

const service = new GraphIntegrityService();

describe("GraphIntegrityService", () => {
    it("accepts a canonical deterministic graph snapshot", () => {
        expect(service.check(createValidSnapshot())).toEqual({ valid: true, issues: [] });
    });

    it("reports schema, duplicate, endpoint, edge-shape, and source violations", () => {
        const snapshot = createValidSnapshot();
        const document = getDocument(snapshot, "markdown:notes/overview.md");
        const tag = getTag(snapshot);
        const invalidEdge: KnowledgeGraphEdge = {
            ...snapshot.edges[0]!,
            id: "edge:links_to:markdown:notes/overview.md:tag:retrieval",
            sourceNodeId: document.id,
            targetNodeId: tag.id,
            type: "links_to",
            origin: "obsidian-link",
            sources: [],
        };
        const missingEndpointEdge: KnowledgeGraphEdge = {
            ...snapshot.edges[1]!,
            id: "edge:links_to:markdown:notes/overview.md:missing",
            targetNodeId: "missing",
        };
        const invalid: GraphSnapshotV1 = {
            ...snapshot,
            schemaVersion: 2 as typeof GRAPH_SNAPSHOT_SCHEMA_VERSION,
            nodes: [...snapshot.nodes, document],
            edges: [...snapshot.edges, invalidEdge, missingEndpointEdge, missingEndpointEdge],
        };

        const codes = service.check(invalid).issues.map((issue) => issue.code);

        expect(codes).toEqual(expect.arrayContaining([
            "unsupported-schema",
            "duplicate-node-id",
            "duplicate-edge-id",
            "missing-edge-endpoint",
            "invalid-edge-shape",
            "invalid-source",
        ]));
    });

    it("reports non-canonical, hidden, orphaned, and unsorted graph facts", () => {
        const snapshot = createValidSnapshot();
        const section = getSection(snapshot);
        const hiddenDocument: DocumentGraphNode = {
            ...getDocument(snapshot, "markdown:notes/details.md"),
            id: "markdown:.vault-coach/hidden.md",
            documentId: "markdown:.vault-coach/hidden.md",
            filePath: ".vault-coach/hidden.md",
        };
        const orphanSection: SectionGraphNode = {
            ...section,
            id: createSectionNodeId("markdown:notes/missing.md", section.headingPath, section.occurrence),
            documentId: "markdown:notes/missing.md",
            filePath: "notes/missing.md",
        };
        const nonCanonicalTag: TagGraphNode = {
            ...getTag(snapshot),
            id: "tag:Retrieval",
            normalizedName: "Retrieval",
        };
        const invalid: GraphSnapshotV1 = {
            ...snapshot,
            nodes: [nonCanonicalTag, orphanSection, hiddenDocument, ...snapshot.nodes],
            edges: snapshot.edges.map((edge) => ({ ...edge, sources: [...edge.sources].reverse() })),
        };

        const codes = service.check(invalid).issues.map((issue) => issue.code);

        expect(codes).toEqual(expect.arrayContaining([
            "non-canonical-id",
            "hidden-path-leak",
            "invalid-section-owner",
            "unsorted-snapshot",
        ]));
    });
});

function createValidSnapshot(): GraphSnapshotV1 {
    const details: DocumentGraphNode = {
        id: "markdown:notes/details.md",
        type: "document",
        documentId: "markdown:notes/details.md",
        filePath: "notes/details.md",
        documentType: "markdown",
        title: "details",
        contentHash: "details-hash",
        modifiedAt: 1704164645000,
    };
    const overview: DocumentGraphNode = {
        id: "markdown:notes/overview.md",
        type: "document",
        documentId: "markdown:notes/overview.md",
        filePath: "notes/overview.md",
        documentType: "markdown",
        title: "overview",
        contentHash: "overview-hash",
        modifiedAt: 1704164645000,
    };
    const section: SectionGraphNode = {
        id: createSectionNodeId(overview.documentId, ["Retrieval"], 0),
        type: "section",
        documentId: overview.documentId,
        filePath: overview.filePath,
        headingPath: ["Retrieval"],
        occurrence: 0,
        chunkIds: ["chunk-overview-1"],
        locator: {
            type: "markdown",
            filePath: overview.filePath,
            heading: "Retrieval",
        },
    };
    const tag: TagGraphNode = {
        id: "tag:retrieval",
        type: "tag",
        normalizedName: "retrieval",
        displayName: "retrieval",
    };
    const contains: KnowledgeGraphEdge = {
        id: createGraphEdgeId("contains", overview.id, section.id),
        sourceNodeId: overview.id,
        targetNodeId: section.id,
        type: "contains",
        confidence: 0.9,
        origin: "heading-structure",
        sources: [{
            sourceFilePath: overview.filePath,
            sourceDocumentId: overview.documentId,
            sourceKind: "heading-structure",
            chunkIds: ["chunk-overview-1"],
        }],
    };
    const linksTo: KnowledgeGraphEdge = {
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
            chunkIds: ["chunk-overview-1"],
            startLine: 3,
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
            chunkIds: ["chunk-overview-1"],
            startLine: 4,
        }],
    };

    return {
        schemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
        nodes: [details, overview, section, tag],
        edges: [contains, linksTo, taggedWith],
        stats: {
            documentCount: 2,
            sectionCount: 1,
            tagCount: 1,
            edgeCount: 3,
        },
    };
}

function getDocument(snapshot: GraphSnapshotV1, id: string): DocumentGraphNode {
    const node = snapshot.nodes.find((candidate: KnowledgeGraphNode) => candidate.id === id);
    if (!node || node.type !== "document") throw new Error(`Missing document node: ${id}`);
    return node;
}

function getSection(snapshot: GraphSnapshotV1): SectionGraphNode {
    const node = snapshot.nodes.find((candidate: KnowledgeGraphNode) => candidate.type === "section");
    if (!node || node.type !== "section") throw new Error("Missing section node.");
    return node;
}

function getTag(snapshot: GraphSnapshotV1): TagGraphNode {
    const node = snapshot.nodes.find((candidate: KnowledgeGraphNode) => candidate.type === "tag");
    if (!node || node.type !== "tag") throw new Error("Missing tag node.");
    return node;
}
