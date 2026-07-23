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

    it("stores semantic concept embeddings in a Float32 shard and collects a recognised orphan", async () => {
        const adapter = new InMemorySemanticAdapter();
        const store = new JsonSemanticGraphStore(adapter);
        const state = semanticState();
        state.embeddings = [{
            conceptId: "concept:00000001",
            modelSignature: "ollama:embeddinggemma",
            inputHash: "embedding-hash",
            vector: [0.125, 0.5, -0.25],
            updatedAt: 1,
        }];
        const orphan = ".vault-coach/graph/semantic/embeddings/vectors-deadbeef.bin";
        adapter.binaryFiles.set(orphan, new Uint8Array([1, 2, 3]).buffer);

        await store.save(state);

        const manifest = JSON.parse(await adapter.read(SEMANTIC_GRAPH_MANIFEST_PATH)) as { embeddingsBinaryPath?: string };
        expect(manifest.embeddingsBinaryPath).toMatch(/embeddings\/vectors-[0-9a-f]+\.bin$/);
        expect(manifest.embeddingsBinaryPath && adapter.binaryFiles.has(manifest.embeddingsBinaryPath)).toBe(true);
        expect(adapter.binaryFiles.has(orphan)).toBe(false);
        const loaded = await store.load();
        expect(loaded?.embeddings[0]).toMatchObject({ conceptId: "concept:00000001", vector: [0.125, 0.5, -0.25] });

        const firstBinaryPath = manifest.embeddingsBinaryPath;
        state.embeddings[0]!.vector = [0.25, 0.5, -0.25];
        await store.save(state);

        const nextManifest = JSON.parse(await adapter.read(SEMANTIC_GRAPH_MANIFEST_PATH)) as { embeddingsBinaryPath?: string };
        expect(nextManifest.embeddingsBinaryPath).not.toBe(firstBinaryPath);
        expect(firstBinaryPath && adapter.binaryFiles.has(firstBinaryPath)).toBe(false);
        await expect(store.load()).resolves.toMatchObject({
            embeddings: [expect.objectContaining({ vector: [0.25, 0.5, -0.25] })],
        });

        await store.clear();
        expect(adapter.binaryFiles.size).toBe(0);
        expect(Array.from(adapter.files.keys()).some((path) => path.includes("semantic/embeddings/"))).toBe(false);
    });

    it("lazily migrates a legacy JSON embedding payload to a binary shard on the next write", async () => {
        const adapter = new InMemorySemanticAdapter();
        const legacyAdapter: SemanticGraphStorageAdapter = {
            exists: (path) => adapter.exists(path),
            read: (path) => adapter.read(path),
            write: (path, data) => adapter.write(path, data),
            mkdir: (path) => adapter.mkdir(path),
            rename: (oldPath, newPath) => adapter.rename(oldPath, newPath),
            remove: (path) => adapter.remove(path),
            list: (path) => adapter.list(path),
        };
        const state = semanticState();
        state.embeddings = [{
            conceptId: "concept:00000001",
            modelSignature: "legacy:model",
            inputHash: "legacy-hash",
            vector: [0.1, 0.2],
            updatedAt: 1,
        }];
        const legacyStore = new JsonSemanticGraphStore(legacyAdapter);
        await legacyStore.save(state);

        const store = new JsonSemanticGraphStore(adapter);
        const loaded = await store.load();
        if (!loaded) throw new Error("Expected legacy semantic state.");
        await store.save(loaded);

        const manifest = JSON.parse(await adapter.read(SEMANTIC_GRAPH_MANIFEST_PATH)) as { embeddingsBinaryPath?: string };
        expect(manifest.embeddingsBinaryPath).toMatch(/\.bin$/);
        expect(adapter.binaryFiles.has(manifest.embeddingsBinaryPath!)).toBe(true);
        const reloaded = await store.load();
        expect(reloaded?.embeddings[0]?.vector[0]).toBeCloseTo(0.1, 5);
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
    readonly binaryFiles = new Map<string, ArrayBuffer>();
    readonly directories = new Set<string>();

    async exists(path: string): Promise<boolean> { return this.files.has(path) || this.binaryFiles.has(path) || this.directories.has(path); }
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
    async remove(path: string): Promise<void> { this.files.delete(path); this.binaryFiles.delete(path); this.directories.delete(path); }
    async readBinary(path: string): Promise<ArrayBuffer> {
        const value = this.binaryFiles.get(path);
        if (!value) throw new Error(`Missing binary ${path}`);
        return value.slice(0);
    }
    async writeBinary(path: string, data: ArrayBuffer): Promise<void> { this.binaryFiles.set(path, data.slice(0)); }
    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const files = [...this.files.keys(), ...this.binaryFiles.keys()]
            .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"));
        const folders = Array.from(new Set([...this.directories, ...this.files.keys(), ...this.binaryFiles.keys()]
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => entry.slice(prefix.length).split("/")[0])
            .filter((entry): entry is string => Boolean(entry))
            .map((entry) => `${path}/${entry}`)
            .filter((entry) => entry !== path && !files.includes(entry))));
        return { files, folders };
    }
}
