import { describe, expect, it } from "vitest";
import { SEMANTIC_GRAPH_MANIFEST_PATH } from "../../../src/constants";
import { JsonSemanticGraphStore, type SemanticGraphStorageAdapter } from "../../../src/infrastructure/storage/json-semantic-graph-store";
import { createEmptySemanticGraphState, type SemanticGraphState } from "../../../src/domain/semantic-graph/semantic-graph-types";

describe("JsonSemanticGraphStore", () => {
    it("persists semantic facts in manifest-addressed shards without touching the M2 snapshot path", async () => {
        const adapter = new InMemorySemanticAdapter();
        const store = new JsonSemanticGraphStore(adapter);
        const state = semanticState();

        await store.save(state);

        expect(adapter.files.has(SEMANTIC_GRAPH_MANIFEST_PATH)).toBe(true);
        expect(Array.from(adapter.files.keys()).some((path) => path.includes("/concepts/"))).toBe(true);
        expect(adapter.files.has(".vault-coach/graph/graph-snapshot-v1.json")).toBe(false);
        await expect(store.load()).resolves.toEqual(state);

        await store.clear();
        await expect(store.load()).resolves.toBeNull();
    });
});

function semanticState(): SemanticGraphState {
    const state = createEmptySemanticGraphState(1);
    state.concepts = [{
        id: "concept:00000001",
        displayName: "Retrieval",
        normalizedName: "retrieval",
        aliases: ["RAG retrieval"],
        description: "Retrieval concept.",
        evidence: [{
            sectionId: "section:one",
            chunkId: "chunk-1",
            locator: { type: "markdown", filePath: "notes/a.md", heading: "A" },
            excerptId: "E1",
            inputHash: "hash",
            textPreview: "Retrieval text.",
        }],
        sourceCandidateIds: ["candidate:concept:one"],
        createdAt: 1,
        updatedAt: 1,
    }];
    return state;
}

class InMemorySemanticAdapter implements SemanticGraphStorageAdapter {
    readonly files = new Map<string, string>();
    readonly directories = new Set<string>();

    async exists(path: string): Promise<boolean> { return this.files.has(path) || this.directories.has(path); }
    async read(path: string): Promise<string> {
        const value = this.files.get(path);
        if (value === undefined) throw new Error(`Missing ${path}`);
        return value;
    }
    async write(path: string, data: string): Promise<void> { this.files.set(path, data); }
    async mkdir(path: string): Promise<void> { this.directories.add(path); }
    async rename(oldPath: string, newPath: string): Promise<void> {
        if (this.files.has(newPath)) throw new Error("Destination file already exists!");
        const value = await this.read(oldPath);
        this.files.set(newPath, value);
        this.files.delete(oldPath);
    }
    async remove(path: string): Promise<void> { this.files.delete(path); this.directories.delete(path); }
}
