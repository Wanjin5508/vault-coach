import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import type { DocumentIndexReader } from "../../../src/domain/documents/document-index-reader";
import type {
    IndexedChunk,
    KnowledgeBaseFileRecord,
    KnowledgeBaseStats,
} from "../../../src/domain/documents/document-types";
import { ObsidianGraphSourceReader } from "../../../src/infrastructure/obsidian/obsidian-graph-source-reader";

const stats: KnowledgeBaseStats = {
    fileCount: 4,
    chunkCount: 8,
    lastIndexedAt: 1704164645000,
    scopeDescription: "整个 Vault",
};

describe("ObsidianGraphSourceReader", () => {
    it("reads indexed Markdown and PDF structure deterministically without leaking hidden or outside files", () => {
        const fixture = createGraphSourceFixture();
        const reader = new ObsidianGraphSourceReader(fixture.app, fixture.documentIndex);

        const firstRead = reader.readAll();
        const secondRead = reader.readAll();

        expect(secondRead).toEqual(firstRead);
        expect(firstRead.documents.map((document) => document.filePath)).toEqual([
            "notes/details.md",
            "notes/overview.md",
            "papers/retrieval.pdf",
        ]);

        const overview = getDocument(firstRead, "notes/overview.md");
        expect(overview).toMatchObject({
            documentId: "markdown:notes/overview.md",
            documentType: "markdown",
            title: "overview",
            contentHash: "overview-hash",
            modifiedAt: 1704164645001,
        });
        expect(overview.sections).toEqual(expect.arrayContaining([
            expect.objectContaining({
                headingPath: [],
                occurrence: 0,
                chunkIds: ["overview-root"],
                locator: { type: "markdown", filePath: "notes/overview.md" },
            }),
            expect.objectContaining({
                headingPath: ["Retrieval"],
                occurrence: 0,
                chunkIds: ["overview-retrieval"],
            }),
            expect.objectContaining({
                headingPath: ["Retrieval", "Fusion"],
                occurrence: 0,
                chunkIds: ["overview-fusion"],
            }),
            expect.objectContaining({
                headingPath: ["Retrieval", "Repeated heading"],
                occurrence: 0,
                chunkIds: [],
            }),
            expect.objectContaining({
                headingPath: ["Retrieval", "Repeated heading"],
                occurrence: 1,
                chunkIds: [],
            }),
            expect.objectContaining({
                headingPath: ["Retrieval", "No body heading"],
                occurrence: 0,
                chunkIds: [],
            }),
        ]));
        expect(overview.links).toEqual([{
            targetFilePath: "notes/details.md",
            chunkIds: [],
            startLine: 2,
            startColumn: 0,
            endLine: 2,
            endColumn: 11,
        }, {
            targetFilePath: "notes/details.md",
            chunkIds: [],
            startLine: 12,
            startColumn: 0,
            endLine: 12,
            endColumn: 19,
        }]);
        expect(overview.embeds).toEqual([{
            targetFilePath: "notes/details.md",
            chunkIds: [],
            startLine: 3,
            startColumn: 0,
            endLine: 3,
            endColumn: 18,
        }]);
        expect(overview.tags).toEqual(expect.arrayContaining([
            expect.objectContaining({ rawName: "#RAG", startLine: 4 }),
            expect.objectContaining({ rawName: "#retrieval/Hybrid", startLine: 4 }),
            { rawName: "retrieval", chunkIds: [] },
            { rawName: "frontmatter/tag", chunkIds: [] },
        ]));

        const details = getDocument(firstRead, "notes/details.md");
        expect(details.links).toEqual([{
            targetFilePath: "notes/overview.md",
            chunkIds: [],
        }]);

        const pdf = getDocument(firstRead, "papers/retrieval.pdf");
        expect(pdf.sections).toEqual([{
            headingPath: ["Page 1"],
            occurrence: 0,
            chunkIds: ["pdf-page-1"],
            locator: {
                type: "pdf",
                filePath: "papers/retrieval.pdf",
                pageStart: 1,
                pageEnd: 1,
            },
        }]);

        expect(firstRead.diagnostics).toEqual([
            expect.objectContaining({
                code: "missing-indexed-file",
                filePath: "notes/missing.md",
            }),
            expect.objectContaining({
                code: "outside-index-target",
                filePath: "notes/overview.md",
                link: "outside",
            }),
            expect.objectContaining({
                code: "unresolved-link-target",
                filePath: "notes/overview.md",
                link: "missing-target",
            }),
        ]);
    });

    it("reads a selected indexed path only and reports an index record missing from the Vault", () => {
        const fixture = createGraphSourceFixture();
        const reader = new ObsidianGraphSourceReader(fixture.app, fixture.documentIndex);

        const result = reader.readPaths([
            ".vault-coach/graph/graph-snapshot-v1.json",
            "notes/missing.md",
            "notes/overview.md",
            "outside.md",
        ]);

        expect(result.documents.map((document) => document.filePath)).toEqual(["notes/overview.md"]);
        expect(result.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: "missing-indexed-file",
                filePath: "notes/missing.md",
            }),
        ]));
        expect(result.documents.some((document) => document.filePath.startsWith(".vault-coach/"))).toBe(false);
    });
});

function getDocument(
    result: ReturnType<ObsidianGraphSourceReader["readAll"]>,
    filePath: string,
) {
    const document = result.documents.find((candidate) => candidate.filePath === filePath);
    if (!document) throw new Error(`Missing graph source document: ${filePath}`);
    return document;
}

function createGraphSourceFixture(): {
    app: App;
    documentIndex: DocumentIndexReader;
} {
    const files = [
        createFile("notes/overview.md", 1704164645001),
        createFile("notes/details.md", 1704164645002),
        createFile("papers/retrieval.pdf", 1704164645003),
        createFile("outside.md", 1704164645004),
    ];
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const records: KnowledgeBaseFileRecord[] = [
        createRecord("notes/overview.md", "markdown", "overview-hash"),
        createRecord("notes/details.md", "markdown", "details-hash"),
        createRecord("papers/retrieval.pdf", "pdf", "pdf-hash"),
        createRecord("notes/missing.md", "markdown", "missing-hash"),
        createRecord(".vault-coach/graph/graph-snapshot-v1.json", "markdown", "hidden-hash"),
    ];
    const chunks: IndexedChunk[] = [
        createMarkdownChunk("overview-root", "notes/overview.md", []),
        createMarkdownChunk("overview-retrieval", "notes/overview.md", ["Retrieval"]),
        createMarkdownChunk("overview-fusion", "notes/overview.md", ["Retrieval", "Fusion"]),
        createMarkdownChunk("overview-repeat-1", "notes/overview.md", ["Retrieval", "Repeated heading"]),
        createMarkdownChunk("overview-repeat-2", "notes/overview.md", ["Retrieval", "Repeated heading"]),
        createMarkdownChunk("details-root", "notes/details.md", []),
        {
            id: "pdf-page-1",
            documentId: "pdf:papers/retrieval.pdf",
            documentType: "pdf",
            filePath: "papers/retrieval.pdf",
            fileName: "retrieval.pdf",
            headingPath: [],
            text: "PDF page one.",
            searchableText: "PDF page one.",
            locator: {
                type: "pdf",
                filePath: "papers/retrieval.pdf",
                pageStart: 1,
                pageEnd: 1,
            },
            contentKind: "native-text",
        },
    ];
    const caches = new Map<string, unknown>([
        ["notes/overview.md", {
            headings: [
                heading("Retrieval", 1, 1),
                heading("Fusion", 2, 5),
                heading("Repeated heading", 2, 8),
                heading("Repeated heading", 2, 11),
                heading("No body heading", 2, 14),
            ],
            links: [
                reference("details", 2, 0, 11),
                reference("outside", 6, 0, 9),
                reference("missing-target", 7, 0, 16),
                reference("../notes/details.md", 12, 0, 19),
            ],
            embeds: [reference("details#Fusion", 3, 0, 18)],
            tags: [
                { tag: "#RAG", position: { start: { line: 4, col: 1 } } },
                { tag: "#retrieval/Hybrid", position: { start: { line: 4, col: 8 } } },
            ],
            frontmatter: { tags: ["retrieval", "frontmatter/tag"] },
        }],
        ["notes/details.md", {
            headings: [],
            embeds: [],
            tags: [],
        }],
        ["papers/retrieval.pdf", null],
    ]);
    const targetBySourceAndLink = new Map<string, TFile>([
        ["notes/overview.md\u0000details", requireFile(filesByPath, "notes/details.md")],
        ["notes/overview.md\u0000details#Fusion", requireFile(filesByPath, "notes/details.md")],
        ["notes/overview.md\u0000../notes/details.md", requireFile(filesByPath, "notes/details.md")],
        ["notes/overview.md\u0000outside", requireFile(filesByPath, "outside.md")],
    ]);
    const app = {
        vault: {
            getAbstractFileByPath: (path: string): TFile | null => filesByPath.get(path) ?? null,
        },
        metadataCache: {
            getFileCache: (file: TFile): unknown => caches.get(file.path) ?? null,
            getFirstLinkpathDest: (link: string, sourcePath: string): TFile | null => {
                return targetBySourceAndLink.get(`${sourcePath}\u0000${link}`) ?? null;
            },
            resolvedLinks: {
                "notes/details.md": {
                    "notes/overview.md": 1,
                },
            },
        },
    } as unknown as App;

    return {
        app,
        documentIndex: createDocumentIndex(records, chunks),
    };
}

function createDocumentIndex(
    records: readonly KnowledgeBaseFileRecord[],
    chunks: readonly IndexedChunk[],
): DocumentIndexReader {
    return {
        isReady: () => true,
        getStats: () => ({ ...stats }),
        getAllChunks: () => [...chunks],
        getChunkById: (chunkId) => chunks.find((chunk) => chunk.id === chunkId) ?? null,
        getChunksByIds: (chunkIds) => chunks.filter((chunk) => chunkIds.includes(chunk.id)),
        getChunksByFilePath: (filePath) => chunks.filter((chunk) => chunk.filePath === filePath),
        getFileRecords: () => records.map((record) => ({ ...record, chunkIds: [...record.chunkIds] })),
        getFileRecord: (filePath) => records.find((record) => record.filePath === filePath) ?? null,
        readDocumentText: async () => null,
        searchKeyword: () => [],
    };
}

function createFile(path: string, modifiedAt: number): TFile {
    const fileName = path.split("/").pop() ?? path;
    const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
    return Object.assign(new TFile(), {
        path,
        extension,
        basename: extension.length > 0 ? fileName.slice(0, -(extension.length + 1)) : fileName,
        stat: { size: 100, mtime: modifiedAt },
    });
}

function createRecord(
    filePath: string,
    documentType: "markdown" | "pdf",
    contentHash: string,
): KnowledgeBaseFileRecord {
    return {
        documentId: `${documentType}:${filePath}`,
        documentType,
        filePath,
        contentHash,
        modifiedTime: filePath === "notes/overview.md" ? 1704164645001 : undefined,
        chunkIds: [],
        indexedAt: 1704164645000,
    };
}

function createMarkdownChunk(id: string, filePath: string, headingPath: string[]): IndexedChunk {
    return {
        id,
        documentId: `markdown:${filePath}`,
        documentType: "markdown",
        filePath,
        fileName: filePath.split("/").pop() ?? filePath,
        headingPath,
        text: id,
        searchableText: id,
        locator: {
            type: "markdown",
            filePath,
            ...(headingPath.length > 0 ? { heading: headingPath[headingPath.length - 1] } : {}),
        },
        contentKind: "native-text",
    };
}

function heading(value: string, level: number, line: number): unknown {
    return {
        heading: value,
        level,
        position: { start: { line, col: 0 } },
    };
}

function reference(link: string, line: number, startColumn: number, endColumn: number): unknown {
    return {
        link,
        position: {
            start: { line, col: startColumn },
            end: { line, col: endColumn },
        },
    };
}

function requireFile(filesByPath: ReadonlyMap<string, TFile>, path: string): TFile {
    const file = filesByPath.get(path);
    if (!file) throw new Error(`Missing fixture file: ${path}`);
    return file;
}
