import { describe, expect, it } from "vitest";
import {
    createGraphEdgeId,
    createSectionNodeId,
    createTagNodeId,
    isGraphSourceLocationsSorted,
    isVaultCoachHiddenPath,
    normalizeGraphPath,
    normalizeGraphTagName,
    normalizeHeadingPath,
    sortAndDedupeGraphSources,
    sortGraphEdges,
    stableGraphHash,
} from "../../../src/domain/graph/graph-id";
import type { GraphSourceLocation, KnowledgeGraphEdge } from "../../../src/domain/graph/graph-types";

describe("deterministic graph identifiers", () => {
    it("normalizes Vault paths and tag names without host APIs", () => {
        expect(normalizeGraphPath(" /Knowledge//RAG\\Overview.md ")).toBe("Knowledge/RAG/Overview.md");
        expect(normalizeGraphPath("notes/./retrieval/../rag.md")).toBe("notes/rag.md");
        expect(normalizeGraphTagName(" ## Retrieval / Hybrid / ")).toBe("retrieval/hybrid");
        expect(normalizeGraphTagName("cafe\u0301")).toBe("café");
        expect(normalizeHeadingPath([" Retrieval ", undefined, 42, "Fusion"])).toEqual(["Retrieval", "Fusion"]);
        expect(normalizeHeadingPath(undefined)).toEqual([]);
        expect(normalizeGraphPath(undefined)).toBe("");
        expect(isVaultCoachHiddenPath(".vault-coach/graph/graph-snapshot-v1.json")).toBe(true);
        expect(isVaultCoachHiddenPath("notes/.vault-coach-overview.md")).toBe(false);
    });

    it("creates stable document, section, tag, and edge identifiers", () => {
        const firstSectionId = createSectionNodeId("markdown:notes/RAG.md", ["RAG", "Fusion"], 0);

        expect(stableGraphHash("same-input")).toBe(stableGraphHash("same-input"));
        expect(firstSectionId).toBe(createSectionNodeId("markdown:notes/RAG.md", [" RAG ", "Fusion"], 0));
        expect(firstSectionId).not.toBe(createSectionNodeId("markdown:notes/RAG.md", ["RAG", "Fusion"], 1));
        expect(createTagNodeId("#Retrieval/Hybrid")).toBe("tag:retrieval/hybrid");
        expect(createGraphEdgeId("links_to", "markdown:notes/a.md", "markdown:notes/b.md"))
            .toBe("edge:links_to:markdown:notes/a.md:markdown:notes/b.md");
    });

    it("sorts and deduplicates provenance while preserving its stable meaning", () => {
        const laterSource: GraphSourceLocation = {
            sourceFilePath: "notes/z.md",
            sourceDocumentId: "markdown:notes/z.md",
            sourceKind: "obsidian-link",
            targetFilePath: "notes/target.md",
            chunkIds: ["chunk-b", "chunk-a", "chunk-b"],
            startLine: 4,
        };
        const firstSource: GraphSourceLocation = {
            sourceFilePath: "notes/a.md",
            sourceDocumentId: "markdown:notes/a.md",
            sourceKind: "obsidian-link",
            targetFilePath: "notes/target.md",
            chunkIds: [],
            startLine: 1,
        };

        expect(sortAndDedupeGraphSources([laterSource, firstSource, laterSource])).toEqual([
            firstSource,
            { ...laterSource, chunkIds: ["chunk-a", "chunk-b"] },
        ]);
        expect(isGraphSourceLocationsSorted([laterSource])).toBe(false);
        expect(isGraphSourceLocationsSorted(sortAndDedupeGraphSources([laterSource, firstSource]))).toBe(true);

        const edges: KnowledgeGraphEdge[] = [
            createLinkEdge("edge:links_to:markdown:notes/z.md:markdown:notes/target.md", laterSource),
            createLinkEdge("edge:links_to:markdown:notes/a.md:markdown:notes/target.md", firstSource),
        ];
        expect(sortGraphEdges(edges).map((edge) => edge.id)).toEqual([
            "edge:links_to:markdown:notes/a.md:markdown:notes/target.md",
            "edge:links_to:markdown:notes/z.md:markdown:notes/target.md",
        ]);
    });
});

function createLinkEdge(id: string, source: GraphSourceLocation): KnowledgeGraphEdge {
    return {
        id,
        sourceNodeId: source.sourceDocumentId,
        targetNodeId: "markdown:notes/target.md",
        type: "links_to",
        confidence: 0.95,
        origin: "obsidian-link",
        sources: [source],
    };
}
