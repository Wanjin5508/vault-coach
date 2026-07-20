import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { GRAPH_DIR_PATH, GRAPH_SNAPSHOT_PATH } from "../../../src/constants";
import type { GraphSnapshotV1 } from "../../../src/domain/graph/graph-types";
import {
    JsonGraphStore,
    type GraphStorageAdapter,
} from "../../../src/infrastructure/storage/json-graph-store";

class InMemoryGraphStorageAdapter implements GraphStorageAdapter {
    readonly files = new Map<string, string>();
    readonly directories = new Set<string>();
    private failNextRenameTo: string | null = null;

    async exists(path: string): Promise<boolean> {
        return this.files.has(path) || this.directories.has(path);
    }

    async read(path: string): Promise<string> {
        const content = this.files.get(path);
        if (content === undefined) throw new Error(`找不到测试文件：${path}`);
        return content;
    }

    async write(path: string, data: string): Promise<void> {
        this.files.set(path, data);
    }

    async mkdir(path: string): Promise<void> {
        this.directories.add(path);
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        if (this.failNextRenameTo === newPath) {
            this.failNextRenameTo = null;
            throw new Error("Simulated graph replacement interruption.");
        }
        if (this.files.has(newPath)) throw new Error("Destination file already exists!");
        const content = await this.read(oldPath);
        this.files.set(newPath, content);
        this.files.delete(oldPath);
    }

    async remove(path: string): Promise<void> {
        this.files.delete(path);
    }

    failNextReplacement(): void {
        this.failNextRenameTo = GRAPH_SNAPSHOT_PATH;
    }
}

describe("JsonGraphStore", () => {
    it("writes a validated versioned snapshot through a temporary JSON file", async () => {
        const adapter = new InMemoryGraphStorageAdapter();
        const store = new JsonGraphStore(adapter);
        const snapshot = readSnapshotFixture();

        await store.save(snapshot);

        expect(JSON.parse(adapter.files.get(GRAPH_SNAPSHOT_PATH) ?? "")).toEqual(snapshot);
        expect(Array.from(adapter.directories)).toEqual(expect.arrayContaining([".vault-coach", GRAPH_DIR_PATH]));
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.tmp`)).toBe(false);
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.bak`)).toBe(false);
    });

    it("updates an existing snapshot when the Vault adapter forbids rename-overwrite", async () => {
        const adapter = new InMemoryGraphStorageAdapter();
        const store = new JsonGraphStore(adapter);
        const snapshot = readSnapshotFixture();
        await store.save(snapshot);
        const updated = withUpdatedOverviewHash(snapshot, "updated-hash");

        await store.save(updated);

        expect(JSON.parse(adapter.files.get(GRAPH_SNAPSHOT_PATH) ?? "")).toEqual(updated);
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.bak`)).toBe(false);
    });

    it("recovers a valid backup after an interrupted replacement and preserves the prior snapshot", async () => {
        const adapter = new InMemoryGraphStorageAdapter();
        const store = new JsonGraphStore(adapter);
        const original = readSnapshotFixture();
        const updated = withUpdatedOverviewHash(original, "replacement-hash");
        await store.save(original);
        adapter.failNextReplacement();

        await expect(store.save(updated)).rejects.toThrow("Simulated graph replacement interruption");

        expect(JSON.parse(adapter.files.get(GRAPH_SNAPSHOT_PATH) ?? "")).toEqual(original);
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.tmp`)).toBe(true);
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.bak`)).toBe(false);
    });

    it("restores a valid backup when no final snapshot remains and ignores a corrupt temporary file", async () => {
        const adapter = new InMemoryGraphStorageAdapter();
        const store = new JsonGraphStore(adapter);
        const snapshot = readSnapshotFixture();
        adapter.files.set(`${GRAPH_SNAPSHOT_PATH}.tmp`, readFixture("corrupt-graph-snapshot.json"));
        adapter.files.set(`${GRAPH_SNAPSHOT_PATH}.bak`, JSON.stringify(snapshot));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(store.load()).resolves.toEqual(snapshot);

        expect(warn).toHaveBeenCalled();
        expect(adapter.files.has(GRAPH_SNAPSHOT_PATH)).toBe(true);
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.tmp`)).toBe(false);
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.bak`)).toBe(false);
    });

    it("rejects malformed, unsupported, and integrity-invalid snapshots without overwriting facts", async () => {
        const adapter = new InMemoryGraphStorageAdapter();
        const store = new JsonGraphStore(adapter);
        const original = readSnapshotFixture();
        await store.save(original);

        await expect(store.save({ ...original, nodes: [...original.nodes].reverse() })).rejects.toThrow("unsorted-snapshot");
        expect(JSON.parse(adapter.files.get(GRAPH_SNAPSHOT_PATH) ?? "")).toEqual(original);

        adapter.files.set(GRAPH_SNAPSHOT_PATH, readFixture("corrupt-graph-snapshot.json"));
        await expect(store.load()).rejects.toThrow("无法解析");

        adapter.files.set(GRAPH_SNAPSHOT_PATH, readFixture("unsupported-graph-snapshot.json"));
        await expect(store.load()).rejects.toThrow("schema 不受支持");
    });

    it("clears only graph snapshot recovery files and preserves future layout state", async () => {
        const adapter = new InMemoryGraphStorageAdapter();
        const store = new JsonGraphStore(adapter);
        await store.save(readSnapshotFixture());
        adapter.files.set(`${GRAPH_SNAPSHOT_PATH}.tmp`, "temporary");
        adapter.files.set(`${GRAPH_SNAPSHOT_PATH}.bak`, "backup");
        adapter.files.set(`${GRAPH_DIR_PATH}/layout-state-v1.json`, "layout");

        await store.clear();

        expect(adapter.files.has(GRAPH_SNAPSHOT_PATH)).toBe(false);
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.tmp`)).toBe(false);
        expect(adapter.files.has(`${GRAPH_SNAPSHOT_PATH}.bak`)).toBe(false);
        expect(adapter.files.get(`${GRAPH_DIR_PATH}/layout-state-v1.json`)).toBe("layout");
    });
});

function readSnapshotFixture(): GraphSnapshotV1 {
    return JSON.parse(readFixture("expected-graph-v1.json")) as GraphSnapshotV1;
}

function readFixture(fileName: string): string {
    return readFileSync(fileURLToPath(new URL(`../../fixtures/vault-graph/${fileName}`, import.meta.url)), "utf8");
}

function withUpdatedOverviewHash(snapshot: GraphSnapshotV1, contentHash: string): GraphSnapshotV1 {
    return {
        ...snapshot,
        nodes: snapshot.nodes.map((node) => node.type === "document" && node.filePath === "notes/overview.md"
            ? { ...node, contentHash }
            : node),
    };
}
