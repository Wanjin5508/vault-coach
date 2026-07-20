import { describe, expect, it, vi } from "vitest";
import { App, TFile, normalizePath } from "obsidian";
import { GRAPH_SNAPSHOT_PATH } from "../../src/constants";
import { createDefaultSettings } from "../../src/settings";
import { VaultCoachRuntime, type VaultCoachRuntimeHost } from "../../src/app/vault-coach-runtime";
import type { VaultCoachSettings } from "../../src/app/config/settings-types";

const TEST_CONFIG_DIR = "test-config";

describe("VaultCoachRuntime graph rebuild integration", () => {
    it("builds and persists a deterministic graph after a successful text rebuild without vector retrieval", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();

        await harness.runtime.rebuildKnowledgeBase(false);

        const snapshot = await harness.runtime.application.graph.getSnapshot();
        expect(harness.runtime.isTextIndexDirty()).toBe(false);
        expect(harness.runtime.getKnowledgeBaseStats()).toMatchObject({ fileCount: 2, chunkCount: 2 });
        expect(snapshot).toMatchObject({
            stats: { documentCount: 2, sectionCount: 2, tagCount: 0, edgeCount: 3 },
        });
        expect(snapshot?.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "links_to", sourceNodeId: "markdown:overview.md", targetNodeId: "markdown:details.md" }),
        ]));
        expect(JSON.parse(harness.adapter.files.get(GRAPH_SNAPSHOT_PATH) ?? "")).toEqual(snapshot);

        await harness.runtime.dispose();
    });

    it("keeps a successful text index when graph persistence fails", async () => {
        const harness = createRuntimeHarness((path) => path === `${GRAPH_SNAPSHOT_PATH}.tmp`);
        const graphError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await harness.runtime.initialize();

        await harness.runtime.rebuildKnowledgeBase(false);

        expect(harness.runtime.isTextIndexDirty()).toBe(false);
        expect(harness.runtime.getKnowledgeBaseStats()).toMatchObject({ fileCount: 2, chunkCount: 2 });
        expect(await harness.runtime.application.graph.getSnapshot()).toBeNull();
        expect(harness.adapter.files.has(`${TEST_CONFIG_DIR}/plugins/vault-coach/index-snapshot.json`)).toBe(true);
        expect(graphError).toHaveBeenCalledWith(
            "[VaultCoachRuntime] 图谱构建失败，文本索引将保持可用。",
            expect.any(Error),
        );

        await harness.runtime.dispose();
    });

    it("still builds the graph when vector indexing falls back after a failure", async () => {
        const harness = createRuntimeHarness();
        const vectorError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await harness.runtime.initialize();
        const services = (harness.runtime as unknown as {
            applicationContainer: { services: { ragEngine: { rebuildVectorIndex(signal?: AbortSignal): Promise<unknown> } } };
        }).applicationContainer.services;
        vi.spyOn(services.ragEngine, "rebuildVectorIndex").mockRejectedValueOnce(new Error("embedding unavailable"));

        await harness.runtime.rebuildKnowledgeBase(false);

        expect(await harness.runtime.application.graph.getSnapshot()).toMatchObject({
            stats: { documentCount: 2, edgeCount: 3 },
        });
        expect(vectorError).toHaveBeenCalledWith(
            "[VaultCoachRuntime] 向量索引建立失败，将回退到关键词检索。",
            expect.any(Error),
        );

        await harness.runtime.dispose();
    });
});

function createRuntimeHarness(failWrite: ((path: string) => boolean) | null = null): {
    runtime: VaultCoachRuntime;
    adapter: InMemoryVaultAdapter;
} {
    const files = new Map<string, { file: TFile; content: string }>([
        ["details.md", {
            file: createFile("details.md", 1704164645000),
            content: "# Details\n\nHybrid retrieval combines keyword and vector evidence.",
        }],
        ["overview.md", {
            file: createFile("overview.md", 1704164645001),
            content: "# Overview\n\n[[details]]",
        }],
    ]);
    const adapter = new InMemoryVaultAdapter(failWrite);
    const app = {
        vault: {
            configDir: TEST_CONFIG_DIR,
            adapter,
            getFiles: (): TFile[] => Array.from(files.values()).map((entry) => entry.file),
            getAbstractFileByPath: (path: string): TFile | null => files.get(normalizePath(path))?.file ?? null,
            cachedRead: async (file: TFile): Promise<string> => {
                const entry = files.get(file.path);
                if (!entry) throw new Error(`Missing fixture file: ${file.path}`);
                return entry.content;
            },
        },
        metadataCache: {
            getFileCache: (): null => null,
            getFirstLinkpathDest: (link: string, sourcePath: string): TFile | null => {
                return sourcePath === "overview.md" && link === "details" ? files.get("details.md")?.file ?? null : null;
            },
            resolvedLinks: {
                "overview.md": { "details.md": 1 },
            },
        },
        secretStorage: {
            getSecret: (): null => null,
        },
    } as unknown as App;
    const settings: VaultCoachSettings = {
        ...createDefaultSettings(),
        enableVectorRetrieval: false,
        enableAutoIndexSync: false,
    };
    const host: VaultCoachRuntimeHost = {
        app,
        pluginId: "vault-coach",
        getSettings: () => settings,
        onStateChanged: () => undefined,
        showNotice: () => undefined,
        translate: (key) => key,
    };

    return {
        runtime: new VaultCoachRuntime(host),
        adapter,
    };
}

class InMemoryVaultAdapter {
    readonly files = new Map<string, string>();
    readonly directories = new Set<string>();

    constructor(private readonly failWrite: ((path: string) => boolean) | null) {}

    async exists(path: string): Promise<boolean> {
        return this.files.has(path) || this.directories.has(path);
    }

    async read(path: string): Promise<string> {
        const content = this.files.get(path);
        if (content === undefined) throw new Error(`Missing stored fixture: ${path}`);
        return content;
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const content = await this.read(path);
        return new TextEncoder().encode(content).buffer;
    }

    async write(path: string, content: string): Promise<void> {
        if (this.failWrite?.(path)) throw new Error(`Refused fixture write: ${path}`);
        this.files.set(path, content);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        if (this.failWrite?.(path)) throw new Error(`Refused fixture write: ${path}`);
        this.files.set(path, new TextDecoder().decode(data));
    }

    async mkdir(path: string): Promise<void> {
        this.directories.add(path);
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        if (this.files.has(newPath)) throw new Error(`Destination file already exists: ${newPath}`);
        const content = await this.read(oldPath);
        this.files.set(newPath, content);
        this.files.delete(oldPath);
    }

    async remove(path: string): Promise<void> {
        this.files.delete(path);
        this.directories.delete(path);
    }

    async rmdir(path: string, recursive: boolean): Promise<void> {
        if (!recursive) {
            this.directories.delete(path);
            return;
        }
        for (const filePath of Array.from(this.files.keys())) {
            if (filePath === path || filePath.startsWith(`${path}/`)) this.files.delete(filePath);
        }
        for (const directoryPath of Array.from(this.directories)) {
            if (directoryPath === path || directoryPath.startsWith(`${path}/`)) this.directories.delete(directoryPath);
        }
    }
}

function createFile(path: string, modifiedAt: number): TFile {
    const fileName = path.split("/").pop() ?? path;
    const extension = fileName.split(".").pop() ?? "";
    return Object.assign(new TFile(), {
        path,
        extension,
        basename: fileName.slice(0, -(extension.length + 1)),
        stat: { size: 100, mtime: modifiedAt },
    });
}
