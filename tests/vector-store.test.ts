import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createEmbeddingFingerprint } from "../src/domain/embedding/embedding-fingerprint";
import type { VectorRecord } from "../src/domain/retrieval/retrieval-types";
import { VaultCoachPersistentStore } from "../src/persistent-store";
import { EmbeddedExactVectorStore } from "../src/vector-store";

const baseDescriptor = {
    providerId: "ollama" as const,
    endpointIdentity: "http://localhost:11434",
    model: "embed",
    revision: "test",
    modelDtype: "fp32",
    outputDtype: "float32" as const,
    pooling: "mean",
    normalization: "consumer-l2-v1",
    preprocessing: { document: "identity-v1", query: "identity-v1", graph: "identity-v1" },
    implementationVersion: 1,
};

describe("EmbeddedExactVectorStore generations", () => {
    it("activates a verified generation and rejects mismatched query fingerprints", async () => {
        const { store } = createStore();
        const fingerprint = createEmbeddingFingerprint(baseDescriptor, 2);
        await store.replaceAll([record("a", [1, 0]), record("b", [0, 1])], fingerprint);

        await expect(store.search(new Float32Array([1, 0]), fingerprint, { topK: 1 }))
            .resolves.toEqual([expect.objectContaining({ chunkId: "a", similarity: 1 })]);
        const changed = createEmbeddingFingerprint({ ...baseDescriptor, modelDtype: "q4" }, 2);
        await expect(store.search(new Float32Array([1, 0]), changed, { topK: 1 }))
            .rejects.toMatchObject({ code: "fingerprint-mismatch" });
    });

    it("rejects an invalid replacement as one batch and retains the active generation", async () => {
        const { store } = createStore();
        const fingerprint = createEmbeddingFingerprint(baseDescriptor, 2);
        await store.replaceAll([record("old", [1, 0])], fingerprint);
        await expect(store.replaceAll([record("new", [1, 0]), record("bad", [1, 2, 3])], fingerprint))
            .rejects.toMatchObject({ code: "dimension-mismatch" });
        await expect(store.search(new Float32Array([1, 0]), fingerprint, { topK: 2 }))
            .resolves.toEqual([expect.objectContaining({ chunkId: "old" })]);
    });

    it("restores the previous pointer when activation rename fails", async () => {
        const { store, adapter, persistentStore } = createStore();
        const fingerprint = createEmbeddingFingerprint(baseDescriptor, 2);
        await store.replaceAll([record("old", [1, 0])], fingerprint);
        adapter.failNextActivation = true;
        await expect(store.replaceAll([record("new", [0, 1])], fingerprint)).rejects.toThrow("injected rename failure");

        const reloaded = new EmbeddedExactVectorStore(persistentStore, () => 10);
        const inspection = await reloaded.inspect();
        expect(inspection.status).toBe("ready");
        await expect(reloaded.search(new Float32Array([1, 0]), fingerprint, { topK: 1 }))
            .resolves.toEqual([expect.objectContaining({ chunkId: "old" })]);
    });

    it("recovers the backup generation when the active shard is corrupt", async () => {
        const { store, adapter, persistentStore } = createStore();
        const fingerprint = createEmbeddingFingerprint(baseDescriptor, 2);
        await store.replaceAll([record("first", [1, 0])], fingerprint);
        await store.replaceAll([record("second", [0, 1])], fingerprint);
        adapter.delete("test-config/plugins/vault-coach/knowledge-index/vectors/generations/generation-10-2/shard-000001.bin");

        const reloaded = new EmbeddedExactVectorStore(persistentStore, () => 10);
        expect((await reloaded.inspect()).status).toBe("ready");
        await expect(reloaded.search(new Float32Array([1, 0]), fingerprint, { topK: 1 }))
            .resolves.toEqual([expect.objectContaining({ chunkId: "first" })]);
    });

    it("marks the version 1 manifest as legacy without inventing a fingerprint", async () => {
        const { store, persistentStore } = createStore();
        await persistentStore.saveKnowledgeIndexJson("vectors/manifest.json", { schemaVersion: 1, backend: "embedded-exact" });
        expect(await store.inspect()).toMatchObject({ status: "legacy", fingerprint: null, reasonCode: "unsupported-schema" });
    });
});

function record(chunkId: string, values: number[]): VectorRecord {
    return { chunkId, vector: new Float32Array(values), metadata: { documentId: `doc-${chunkId}`, documentType: "markdown" } };
}

function createStore(): { store: EmbeddedExactVectorStore; persistentStore: VaultCoachPersistentStore; adapter: MemoryAdapter } {
    const adapter = new MemoryAdapter();
    const app = { vault: { configDir: "test-config", adapter } } as unknown as App;
    const persistentStore = new VaultCoachPersistentStore(app, "vault-coach");
    return { store: new EmbeddedExactVectorStore(persistentStore, () => 10), persistentStore, adapter };
}

class MemoryAdapter {
    private readonly text = new Map<string, string>();
    private readonly binary = new Map<string, ArrayBuffer>();
    failNextActivation = false;

    async exists(path: string): Promise<boolean> {
        const prefix = `${path}/`;
        return this.text.has(path) || this.binary.has(path)
            || [...this.text.keys(), ...this.binary.keys()].some((value) => value.startsWith(prefix));
    }
    async mkdir(): Promise<void> {}
    async write(path: string, value: string): Promise<void> { this.text.set(path, value); }
    async read(path: string): Promise<string> {
        const value = this.text.get(path);
        if (value === undefined) throw new Error(`missing text: ${path}`);
        return value;
    }
    async writeBinary(path: string, value: ArrayBuffer): Promise<void> { this.binary.set(path, value.slice(0)); }
    async readBinary(path: string): Promise<ArrayBuffer> {
        const value = this.binary.get(path);
        if (!value) throw new Error(`missing binary: ${path}`);
        return value.slice(0);
    }
    async remove(path: string): Promise<void> { this.delete(path); }
    async rmdir(path: string): Promise<void> {
        const prefix = `${path}/`;
        for (const key of [...this.text.keys()]) if (key === path || key.startsWith(prefix)) this.text.delete(key);
        for (const key of [...this.binary.keys()]) if (key === path || key.startsWith(prefix)) this.binary.delete(key);
    }
    async rename(from: string, to: string): Promise<void> {
        if (this.failNextActivation && from.endsWith("active.json.next") && to.endsWith("active.json")) {
            this.failNextActivation = false;
            throw new Error("injected rename failure");
        }
        if (this.text.has(from)) {
            this.text.set(to, this.text.get(from) as string);
            this.text.delete(from);
            return;
        }
        if (this.binary.has(from)) {
            this.binary.set(to, this.binary.get(from) as ArrayBuffer);
            this.binary.delete(from);
            return;
        }
        throw new Error(`missing rename source: ${from}`);
    }
    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const prefix = `${path}/`;
        const files: string[] = [];
        const folders = new Set<string>();
        for (const value of [...this.text.keys(), ...this.binary.keys()]) {
            if (!value.startsWith(prefix)) continue;
            const remainder = value.slice(prefix.length);
            const separator = remainder.indexOf("/");
            if (separator < 0) files.push(value);
            else folders.add(`${path}/${remainder.slice(0, separator)}`);
        }
        return { files, folders: [...folders] };
    }
    delete(path: string): void { this.text.delete(path); this.binary.delete(path); }
}
