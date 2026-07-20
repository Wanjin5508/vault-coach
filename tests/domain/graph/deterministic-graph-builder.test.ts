import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    buildGraphSnapshot,
    DeterministicGraphBuilder,
    GraphBuildError,
} from "../../../src/domain/graph/deterministic-graph-builder";
import { createGraphEdgeId, createSectionNodeId } from "../../../src/domain/graph/graph-id";
import { GraphIntegrityService } from "../../../src/domain/graph/graph-integrity-service";
import type { GraphSnapshotV1, GraphSourceDocument, KnowledgeGraphEdge } from "../../../src/domain/graph/graph-types";

describe("DeterministicGraphBuilder", () => {
    it("creates the canonical golden snapshot from Obsidian-free source facts", () => {
        const snapshot = buildGraphSnapshot(readGraphSourceFixture());

        expect(snapshot).toEqual(readGraphSnapshotFixture());
        expect(new GraphIntegrityService().check(snapshot)).toEqual({ valid: true, issues: [] });
    });

    it("builds all structural node and edge types, aggregates evidence, and excludes outside targets", () => {
        const sources = createRichSources();
        const snapshot = new DeterministicGraphBuilder().build(sources);
        const overviewId = "markdown:notes/overview.md";
        const detailsId = "markdown:notes/details.md";
        const rootId = createSectionNodeId(overviewId, [], 0);
        const retrievalId = createSectionNodeId(overviewId, ["Retrieval"], 0);

        expect(snapshot.stats).toEqual({
            documentCount: 3,
            sectionCount: 7,
            tagCount: 2,
            edgeCount: 11,
        });
        expect(snapshot.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: rootId, type: "section", chunkIds: ["overview-root"] }),
            expect.objectContaining({
                id: createSectionNodeId(overviewId, ["Retrieval", "Empty heading"], 0),
                type: "section",
                chunkIds: [],
            }),
            expect.objectContaining({
                id: createSectionNodeId("pdf:papers/retrieval.pdf", ["Page 1"], 0),
                type: "section",
                locator: { type: "pdf", filePath: "papers/retrieval.pdf", pageStart: 1, pageEnd: 1 },
            }),
            { id: "tag:rag", type: "tag", normalizedName: "rag", displayName: "rag" },
            { id: "tag:retrieval", type: "tag", normalizedName: "retrieval", displayName: "retrieval" },
        ]));

        expect(getEdge(snapshot, "contains", overviewId, rootId)).toMatchObject({
            confidence: 0.9,
            origin: "heading-structure",
            sources: [{
                sourceFilePath: "notes/overview.md",
                sourceDocumentId: overviewId,
                sourceKind: "heading-structure",
                chunkIds: ["overview-root"],
            }],
        });
        expect(getEdge(snapshot, "contains", rootId, retrievalId).confidence).toBe(0.9);
        expect(getEdge(snapshot, "links_to", overviewId, detailsId)).toMatchObject({
            confidence: 0.95,
            origin: "obsidian-link",
            sources: [
                expect.objectContaining({ startLine: 2, targetFilePath: "notes/details.md" }),
                expect.objectContaining({ startLine: 8, targetFilePath: "notes/details.md" }),
            ],
        });
        expect(getEdge(snapshot, "embeds", overviewId, detailsId)).toMatchObject({
            confidence: 0.9,
            origin: "obsidian-embed",
        });
        expect(getEdge(snapshot, "tagged_with", overviewId, "tag:rag")).toMatchObject({
            confidence: 0.8,
            origin: "obsidian-tag",
            sources: [
                expect.objectContaining({ startLine: 4 }),
                expect.objectContaining({ startLine: 5 }),
            ],
        });
        expect(snapshot.edges.some((edge) => edge.targetNodeId.includes("outside"))).toBe(false);
        expect(new GraphIntegrityService().check(snapshot)).toEqual({ valid: true, issues: [] });
    });

    it("returns byte-equivalent graph facts for shuffled source and collection order", () => {
        const sources = createRichSources();
        const shuffled = [...sources].reverse().map((source) => ({
            ...source,
            sections: [...source.sections].reverse(),
            links: [...source.links].reverse(),
            embeds: [...source.embeds].reverse(),
            tags: [...source.tags].reverse(),
        }));

        expect(buildGraphSnapshot(shuffled)).toEqual(buildGraphSnapshot(sources));
    });

    it("builds a changed-file fragment that can link to an unchanged known document", () => {
        const sources = createRichSources();
        const details = new DeterministicGraphBuilder().build([sources[0]!]).nodes
            .find((node): node is Extract<typeof node, { type: "document" }> => node.type === "document");
        if (!details) throw new Error("Expected details document node.");

        const fragment = new DeterministicGraphBuilder().buildFragment([sources[1]!], [details]);

        expect(fragment.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: createGraphEdgeId("links_to", "markdown:notes/overview.md", "markdown:notes/details.md"),
                type: "links_to",
            }),
        ]));
    });

    it("rejects hidden and duplicate graph source documents instead of silently losing facts", () => {
        const source = createRichSources()[0]!;

        expect(() => buildGraphSnapshot([{ ...source, filePath: ".vault-coach/graph/source.md" }]))
            .toThrow(GraphBuildError);
        expect(() => buildGraphSnapshot([source, { ...source, filePath: "notes/duplicate.md" }]))
            .toThrow("unique document IDs and file paths");
    });
});

function getEdge(
    snapshot: GraphSnapshotV1,
    type: KnowledgeGraphEdge["type"],
    sourceNodeId: string,
    targetNodeId: string,
): KnowledgeGraphEdge {
    const id = createGraphEdgeId(type, sourceNodeId, targetNodeId);
    const edge = snapshot.edges.find((candidate) => candidate.id === id);
    if (!edge) throw new Error(`Missing graph edge: ${id}`);
    return edge;
}

function readGraphSourceFixture(): GraphSourceDocument[] {
    return JSON.parse(readFixture("graph-source-basic.json")) as GraphSourceDocument[];
}

function readGraphSnapshotFixture(): GraphSnapshotV1 {
    return JSON.parse(readFixture("expected-graph-v1.json")) as GraphSnapshotV1;
}

function readFixture(fileName: string): string {
    return readFileSync(fileURLToPath(new URL(`../../fixtures/vault-graph/${fileName}`, import.meta.url)), "utf8");
}

function createRichSources(): GraphSourceDocument[] {
    return [{
        documentId: "markdown:notes/details.md",
        filePath: "notes/details.md",
        documentType: "markdown",
        title: "details",
        contentHash: "details-hash",
        modifiedAt: 1704164645000,
        sections: [],
        links: [],
        embeds: [],
        tags: [],
    }, {
        documentId: "markdown:notes/overview.md",
        filePath: "notes/overview.md",
        documentType: "markdown",
        title: "overview",
        contentHash: "overview-hash",
        modifiedAt: 1704164645001,
        sections: [{
            headingPath: [],
            occurrence: 0,
            chunkIds: ["overview-root"],
            locator: { type: "markdown", filePath: "notes/overview.md" },
        }, {
            headingPath: ["Retrieval"],
            occurrence: 0,
            chunkIds: ["overview-retrieval"],
            locator: { type: "markdown", filePath: "notes/overview.md", heading: "Retrieval" },
        }, {
            headingPath: ["Retrieval", "Fusion"],
            occurrence: 0,
            chunkIds: ["overview-fusion"],
            locator: { type: "markdown", filePath: "notes/overview.md", heading: "Fusion" },
        }, {
            headingPath: ["Retrieval", "Empty heading"],
            occurrence: 0,
            chunkIds: [],
            locator: { type: "markdown", filePath: "notes/overview.md", heading: "Empty heading" },
        }, {
            headingPath: ["Retrieval", "Repeated heading"],
            occurrence: 0,
            chunkIds: [],
            locator: { type: "markdown", filePath: "notes/overview.md", heading: "Repeated heading" },
        }, {
            headingPath: ["Retrieval", "Repeated heading"],
            occurrence: 1,
            chunkIds: [],
            locator: { type: "markdown", filePath: "notes/overview.md", heading: "Repeated heading" },
        }],
        links: [{
            targetFilePath: "notes/details.md",
            chunkIds: ["overview-retrieval"],
            startLine: 2,
        }, {
            targetFilePath: "outside.md",
            chunkIds: [],
            startLine: 3,
        }, {
            targetFilePath: "notes/details.md",
            chunkIds: ["overview-fusion"],
            startLine: 8,
        }],
        embeds: [{
            targetFilePath: "notes/details.md",
            chunkIds: ["overview-fusion"],
            startLine: 3,
        }],
        tags: [{
            rawName: "#RAG",
            chunkIds: ["overview-retrieval"],
            startLine: 4,
        }, {
            rawName: "rag",
            chunkIds: ["overview-fusion"],
            startLine: 5,
        }, {
            rawName: "retrieval",
            chunkIds: [],
        }],
    }, {
        documentId: "pdf:papers/retrieval.pdf",
        filePath: "papers/retrieval.pdf",
        documentType: "pdf",
        title: "retrieval",
        contentHash: "pdf-hash",
        modifiedAt: 1704164645002,
        sections: [{
            headingPath: ["Page 1"],
            occurrence: 0,
            chunkIds: ["pdf-page-1"],
            locator: {
                type: "pdf",
                filePath: "papers/retrieval.pdf",
                pageStart: 1,
                pageEnd: 1,
            },
        }],
        links: [],
        embeds: [],
        tags: [],
    }];
}
