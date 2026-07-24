import { describe, expect, it } from "vitest";
import { createSectionExtractionInputs } from "../../../src/app/semantic-graph/section-extraction-input";
import type { DocumentIndexReader } from "../../../src/domain/documents/document-index-reader";
import type { IndexedChunk } from "../../../src/domain/documents/document-types";
import type { GraphSnapshotV1 } from "../../../src/domain/graph/graph-types";

describe("createSectionExtractionInputs", () => {
    it("reads only direct section chunks and splits oversized content on chunk boundaries", () => {
        const snapshot: GraphSnapshotV1 = {
            schemaVersion: 1,
            nodes: [{
                id: "section:doc:one",
                type: "section",
                documentId: "doc",
                filePath: "notes/a.md",
                headingPath: ["A"],
                occurrence: 0,
                chunkIds: ["chunk-1", "chunk-2", "missing", "foreign"],
                locator: { type: "markdown", filePath: "notes/a.md", heading: "A" },
            }, {
                id: "section:doc:empty",
                type: "section",
                documentId: "doc",
                filePath: "notes/a.md",
                headingPath: ["Empty"],
                occurrence: 0,
                chunkIds: [],
                locator: { type: "markdown", filePath: "notes/a.md", heading: "Empty" },
            }],
            edges: [],
            stats: { documentCount: 0, sectionCount: 2, tagCount: 0, edgeCount: 0 },
        };
        const chunks = new Map<string, IndexedChunk>([
            ["chunk-1", chunk("chunk-1", "notes/a.md", "a".repeat(700))],
            ["chunk-2", chunk("chunk-2", "notes/a.md", "b".repeat(700))],
            ["foreign", chunk("foreign", "notes/b.md", "must not leak")],
        ]);
        const reader = { getChunkById: (chunkId: string) => chunks.get(chunkId) ?? null } as DocumentIndexReader;

        const inputs = createSectionExtractionInputs(snapshot, reader, 1000);

        expect(inputs).toHaveLength(2);
        expect(inputs.map((input) => input.excerpts.map((excerpt) => excerpt.chunkId))).toEqual([["chunk-1"], ["chunk-2"]]);
        expect(inputs.every((input) => input.excerpts[0]?.id === "E1")).toBe(true);
        expect(inputs.every((input) => input.sectionId === "section:doc:one")).toBe(true);
    });
});

function chunk(id: string, filePath: string, text: string): IndexedChunk {
    return {
        id,
        documentId: "doc",
        documentType: "markdown",
        filePath,
        fileName: filePath.split("/").pop() ?? filePath,
        headingPath: ["A"],
        text,
        searchableText: text,
        locator: { type: "markdown", filePath, heading: "A" },
        contentKind: "native-text",
    };
}
