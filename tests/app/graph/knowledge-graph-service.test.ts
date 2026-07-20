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

function createSourceReader(): GraphSourceReader & { readAll: ReturnType<typeof vi.fn> } {
    return {
        readAll: vi.fn(() => ({
            documents: createSources(),
            diagnostics: [],
        })),
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
