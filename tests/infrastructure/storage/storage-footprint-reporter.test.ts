import { describe, expect, it } from "vitest";
import type { App, ListedFiles, Stat } from "obsidian";
import { VaultCoachPersistentStore } from "../../../src/persistent-store";
import { StorageFootprintReporter } from "../../../src/infrastructure/storage/storage-footprint-reporter";

describe("StorageFootprintReporter", () => {
    it("counts only known VaultCoach derived-data roots without walking user notes", async () => {
        const adapter = new FootprintAdapter({
            "test-config/plugins/vault-coach/index-snapshot.json": { size: 10, mtime: 1 },
            "test-config/plugins/vault-coach/knowledge-index/vectors/manifest.json": { size: 5, mtime: 2 },
            "test-config/plugins/vault-coach/knowledge-index/vectors/shard-000001.bin": { size: 12, mtime: 3 },
            ".vault-coach/graph/graph-snapshot-v1.json": { size: 30, mtime: 4 },
            ".vault-coach/graph/semantic/semantic-manifest-v1.json": { size: 7, mtime: 5 },
            ".vault-coach/graph/semantic/sections/aa.json": { size: 8, mtime: 6 },
            ".vault-coach/graph/semantic/embeddings/vectors-a.bin": { size: 16, mtime: 7 },
            ".vault-coach/mastery/mastery-snapshot-v1.json": { size: 20, mtime: 8 },
            ".vault-coach/assessments/sessions/exam-1.json": { size: 25, mtime: 9 },
            ".vault-coach/exams/exam-1.md": { size: 15, mtime: 10 },
            "notes/private.md": { size: 999, mtime: 11 },
        });
        const app = { vault: { configDir: "test-config", adapter } } as unknown as App;
        const store = new VaultCoachPersistentStore(app, "vault-coach");
        const reporter = new StorageFootprintReporter(adapter, store, () => 99);

        const footprint = await reporter.getFootprint();

        expect(footprint).toMatchObject({ generatedAt: 99, totalBytes: 148 });
        expect(footprint.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ category: "text-index", bytes: 10, fileCount: 1 }),
            expect.objectContaining({ category: "vector-index", bytes: 17, fileCount: 2, latestModifiedAt: 3 }),
            expect.objectContaining({ category: "semantic-facts", bytes: 15, fileCount: 2 }),
            expect.objectContaining({ category: "semantic-embeddings", bytes: 16, fileCount: 1 }),
            expect.objectContaining({ category: "assessments", bytes: 25, fileCount: 1 }),
        ]));
    });
});

class FootprintAdapter {
    private readonly files = new Map<string, Pick<Stat, "size" | "mtime">>();

    constructor(files: Record<string, Pick<Stat, "size" | "mtime">>) {
        Object.entries(files).forEach(([path, stat]) => this.files.set(path, stat));
    }

    async stat(path: string): Promise<Stat | null> {
        const file = this.files.get(path);
        if (file) return { type: "file", size: file.size, mtime: file.mtime, ctime: file.mtime };
        const prefix = path.length === 0 ? "" : `${path}/`;
        if (Array.from(this.files.keys()).some((filePath) => filePath.startsWith(prefix))) {
            return { type: "folder", size: 0, mtime: 0, ctime: 0 };
        }
        return null;
    }

    async list(path: string): Promise<ListedFiles> {
        const prefix = path.length === 0 ? "" : `${path}/`;
        const files: string[] = [];
        const folders = new Set<string>();
        for (const filePath of this.files.keys()) {
            if (!filePath.startsWith(prefix)) continue;
            const remainder = filePath.slice(prefix.length);
            const separator = remainder.indexOf("/");
            if (separator === -1) files.push(filePath);
            else folders.add(`${path}/${remainder.slice(0, separator)}`);
        }
        return { files: files.sort(), folders: Array.from(folders).sort() };
    }
}
