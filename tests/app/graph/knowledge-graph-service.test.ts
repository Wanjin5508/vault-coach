import { describe, expect, it, vi } from "vitest";
import { DeterministicGraphBuilder } from "../../../src/domain/graph/deterministic-graph-builder";
import type { GraphStore } from "../../../src/domain/graph/graph-store";
import type { GraphSnapshotV1, GraphSourceDocument } from "../../../src/domain/graph/graph-types";
import {
    KnowledgeGraphService,
    type GraphSourceReader,
} from "../../../src/app/graph/knowledge-graph-service";

describe("KnowledgeGraphService", () => {
    it("rebuilds, validates, saves, and exposes immutable graph facts", async () => {
        const sourceReader = createSourceReader();
        const store = new InMemoryGraphStore();
        const service = new KnowledgeGraphService(sourceReader, new DeterministicGraphBuilder(), store);

        const rebuilt = await service.rebuildAll();
        rebuilt.nodes.pop();
        const snapshot = service.getSnapshot();
        const link = service.findEdgesForNode("markdown:notes/overview.md").find((edge) => edge.type === "links_to");
        if (!snapshot || !link) throw new Error("Expected graph facts were not built.");
        link.sources[0]?.chunkIds.push("mutated");

        expect(sourceReader.readAll).toHaveBeenCalledOnce();
        expect(store.saved).toEqual(snapshot);
        expect(snapshot.nodes).toHaveLength(3);
        expect(service.getNode("markdown:notes/overview.md")).toMatchObject({ type: "document" });
        expect(service.findEdgesForNode("markdown:notes/overview.md")).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "links_to", sources: [expect.objectContaining({ chunkIds: ["overview-link"] })] }),
        ]));
        expect(service.getState()).toEqual({
            dirty: false,
            hasSnapshot: true,
            lastError: null,
            diagnostics: [],
            integrity: { valid: true, issues: [] },
        });
        expect(service.checkIntegrity()).toEqual({ valid: true, issues: [] });
    });

    it("keeps the previous snapshot and marks the graph dirty when persistence fails", async () => {
        const sourceReader = createSourceReader();
        const store = new InMemoryGraphStore();
        const service = new KnowledgeGraphService(sourceReader, new DeterministicGraphBuilder(), store);
        const previous = await service.rebuildAll();
        store.saveError = new Error("graph storage unavailable");

        await expect(service.rebuildAll()).rejects.toThrow("graph storage unavailable");

        expect(service.getSnapshot()).toEqual(previous);
        expect(service.getState()).toMatchObject({
            dirty: true,
            hasSnapshot: true,
            lastError: "graph storage unavailable",
        });
    });

    it("handles a corrupt stored snapshot without blocking startup and records a retryable dirty state", async () => {
        const store = new InMemoryGraphStore();
        store.loadError = new Error("图谱快照 JSON 无法解析");
        const service = new KnowledgeGraphService(createSourceReader(), new DeterministicGraphBuilder(), store);

        await expect(service.load()).resolves.toBeUndefined();

        expect(service.getSnapshot()).toBeNull();
        expect(service.getState()).toEqual({
            dirty: true,
            hasSnapshot: false,
            lastError: "图谱快照 JSON 无法解析",
            diagnostics: [],
            integrity: { valid: true, issues: [] },
        });
    });

    it("retains cloned source diagnostics and the latest integrity report after a successful build", async () => {
        const sourceReader = createSourceReader();
        sourceReader.readAll.mockReturnValueOnce({
            documents: createSources(),
            diagnostics: [{
                code: "unresolved-link-target",
                filePath: "notes/overview.md",
                message: "The target is outside the current graph scope.",
                link: "outside",
            }],
        });
        const service = new KnowledgeGraphService(sourceReader, new DeterministicGraphBuilder(), new InMemoryGraphStore());

        await service.rebuildAll();
        const state = service.getState();
        state.diagnostics[0]!.message = "mutated";
        state.integrity.issues.push({ code: "invalid-source", message: "mutated" });

        expect(service.getState()).toEqual(expect.objectContaining({
            dirty: true,
            diagnostics: [expect.objectContaining({ message: "The target is outside the current graph scope." })],
            integrity: { valid: true, issues: [] },
        }));
    });

    it("replaces changed file facts without performing another full Vault graph read", async () => {
        const sourceReader = createMutableSourceReader();
        const service = new KnowledgeGraphService(sourceReader.reader, new DeterministicGraphBuilder(), new InMemoryGraphStore());
        await service.rebuildAll();
        sourceReader.setSources(createSources().map((source) => source.filePath === "notes/overview.md"
            ? { ...source, contentHash: "overview-v2", tags: [{ rawName: "#incremental", chunkIds: [] }] }
            : source));

        const snapshot = await service.syncChangedFiles({ affectedFiles: ["notes/overview.md"] });

        expect(sourceReader.reader.readAll).toHaveBeenCalledOnce();
        expect(sourceReader.reader.readPaths).toHaveBeenCalledWith(["notes/overview.md"]);
        expect(snapshot.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "markdown:notes/overview.md", contentHash: "overview-v2" }),
            expect.objectContaining({ id: "tag:incremental", type: "tag" }),
        ]));
        expect(snapshot.nodes.some((node) => node.id === "tag:retrieval")).toBe(false);
        expect(service.checkIntegrity()).toEqual({ valid: true, issues: [] });
    });

    it("removes a deleted document and links that pointed to it", async () => {
        const sourceReader = createMutableSourceReader();
        const service = new KnowledgeGraphService(sourceReader.reader, new DeterministicGraphBuilder(), new InMemoryGraphStore());
        await service.rebuildAll();
        sourceReader.setSources(createSources().filter((source) => source.filePath !== "notes/details.md"));

        const snapshot = await service.syncChangedFiles({ affectedFiles: ["notes/details.md"] });

        expect(snapshot.nodes.some((node) => node.id === "markdown:notes/details.md")).toBe(false);
        expect(snapshot.edges.some((edge) => edge.type === "links_to")).toBe(false);
        expect(snapshot.stats.documentCount).toBe(1);
        expect(service.checkIntegrity()).toEqual({ valid: true, issues: [] });
    });

    it("migrates unchanged inbound links and source evidence across a paired file rename", async () => {
        const sourceReader = createMutableSourceReader();
        const service = new KnowledgeGraphService(sourceReader.reader, new DeterministicGraphBuilder(), new InMemoryGraphStore());
        await service.rebuildAll();
        sourceReader.setSources(createSources().map((source) => source.filePath === "notes/details.md"
            ? {
                ...source,
                documentId: "markdown:notes/renamed-details.md",
                filePath: "notes/renamed-details.md",
                title: "renamed-details",
            }
            : source));

        const snapshot = await service.syncChangedFiles(
            { affectedFiles: ["notes/details.md", "notes/renamed-details.md"] },
            [{ oldPath: "notes/details.md", newPath: "notes/renamed-details.md" }],
        );
        const link = snapshot.edges.find((edge) => edge.type === "links_to");

        expect(sourceReader.reader.readAll).toHaveBeenCalledOnce();
        expect(sourceReader.reader.readPaths).toHaveBeenCalledWith(["notes/details.md", "notes/renamed-details.md"]);
        expect(snapshot.nodes.some((node) => node.id === "markdown:notes/details.md")).toBe(false);
        expect(link).toMatchObject({
            sourceNodeId: "markdown:notes/overview.md",
            targetNodeId: "markdown:notes/renamed-details.md",
            sources: [expect.objectContaining({ targetFilePath: "notes/renamed-details.md" })],
        });
        expect(service.checkIntegrity()).toEqual({ valid: true, issues: [] });
    });

    it("keeps the last valid snapshot and makes a failed incremental write retryable", async () => {
        const sourceReader = createMutableSourceReader();
        const store = new InMemoryGraphStore();
        const service = new KnowledgeGraphService(sourceReader.reader, new DeterministicGraphBuilder(), store);
        const previous = await service.rebuildAll();
        sourceReader.setSources(createSources().map((source) => source.filePath === "notes/overview.md"
            ? { ...source, contentHash: "overview-v2" }
            : source));
        store.saveError = new Error("incremental graph storage unavailable");

        await expect(service.syncChangedFiles({ affectedFiles: ["notes/overview.md"] })).rejects.toThrow("incremental graph storage unavailable");

        expect(service.getSnapshot()).toEqual(previous);
        expect(service.getState()).toMatchObject({
            dirty: true,
            lastError: "incremental graph storage unavailable",
        });
    });
});

class InMemoryGraphStore implements GraphStore {
    snapshot: GraphSnapshotV1 | null = null;
    saved: GraphSnapshotV1 | null = null;
    loadError: Error | null = null;
    saveError: Error | null = null;

    async load(): Promise<GraphSnapshotV1 | null> {
        if (this.loadError) throw this.loadError;
        return this.snapshot;
    }

    async save(snapshot: GraphSnapshotV1): Promise<void> {
        if (this.saveError) throw this.saveError;
        this.snapshot = snapshot;
        this.saved = snapshot;
    }

    async clear(): Promise<void> {
        this.snapshot = null;
        this.saved = null;
    }
}

function createSourceReader(): GraphSourceReader & {
    readAll: ReturnType<typeof vi.fn>;
    readPaths: ReturnType<typeof vi.fn>;
} {
    const readPaths = vi.fn((filePaths: readonly string[]) => ({
        documents: createSources().filter((source) => filePaths.includes(source.filePath)),
        diagnostics: [],
    }));
    return {
        readAll: vi.fn(() => ({
            documents: createSources(),
            diagnostics: [],
        })),
        readPaths,
    };
}

function createSources(): GraphSourceDocument[] {
    return [{
        documentId: "markdown:notes/details.md",
        filePath: "notes/details.md",
        documentType: "markdown",
        title: "details",
        contentHash: "details-hash",
        modifiedAt: 1,
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
        modifiedAt: 2,
        sections: [],
        links: [{ targetFilePath: "notes/details.md", chunkIds: ["overview-link"], startLine: 1 }],
        embeds: [],
        tags: [{ rawName: "#retrieval", chunkIds: [] }],
    }];
}

function createMutableSourceReader(): {
    reader: GraphSourceReader & {
        readAll: ReturnType<typeof vi.fn>;
        readPaths: ReturnType<typeof vi.fn>;
    };
    setSources(sources: GraphSourceDocument[]): void;
} {
    let sources = createSources();
    const reader = {
        readAll: vi.fn(() => ({ documents: sources, diagnostics: [] })),
        readPaths: vi.fn((filePaths: readonly string[]) => ({
            documents: sources.filter((source) => filePaths.includes(source.filePath)),
            diagnostics: [],
        })),
    };
    return {
        reader,
        setSources: (nextSources) => {
            sources = nextSources;
        },
    };
}
