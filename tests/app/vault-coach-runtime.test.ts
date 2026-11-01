import { describe, expect, it, vi } from "vitest";
import { App, TFile, normalizePath } from "obsidian";
import { GRAPH_SNAPSHOT_PATH } from "../../src/constants";
import { createDefaultSettings } from "../../src/settings";
import { VaultCoachRuntime, type VaultCoachRuntimeHost } from "../../src/app/vault-coach-runtime";
import type { VaultCoachSettings } from "../../src/app/config/settings-types";
import type { KnowledgeGraphService } from "../../src/app/graph/knowledge-graph-service";

const TEST_CONFIG_DIR = "test-config";

// M6-B 核心可用性测试：验证文本 CoreIndex 能先于向量/图谱对外提供服务。
describe("M6-B CoreIndex readiness", () => {
    // 验证向量构建被 deferred 时，文本 snapshot 完成即可释放首次 readiness。
    it("releases the first readiness request after text indexing while vector indexing is pending", async () => {
        const harness = createRuntimeHarness();
        harness.settings.enableVectorRetrieval = true;
        await harness.runtime.initialize();
        const originalRebuild = harness.runtime.rebuildKnowledgeBase.bind(harness.runtime);
        let fullRebuild: Promise<void> | null = null;
        vi.spyOn(harness.runtime, "rebuildKnowledgeBase").mockImplementation((showNotice, signal) => {
            const rebuild = originalRebuild(showNotice, signal);
            fullRebuild ??= rebuild;
            return rebuild;
        });
        const services = getIndexServices(harness.runtime);
        const vectorBuild = createDeferred<unknown>();
        const rebuildVectorIndex = vi.spyOn(services.ragEngine, "rebuildVectorIndex")
            .mockImplementation(async () => vectorBuild.promise);
        let readySettled = false;
        const ready = harness.runtime.ensureKnowledgeBaseReady().then(() => { readySettled = true; });

        await waitFor(() => rebuildVectorIndex.mock.calls.length === 1);
        await waitFor(() => readySettled);

        expect(harness.runtime.getKnowledgeBaseStats()).toMatchObject({ fileCount: 2, chunkCount: 2 });
        expect(readySettled).toBe(true);
        expect(harness.adapter.files.has(`${TEST_CONFIG_DIR}/plugins/vault-coach/index-snapshot.json`)).toBe(true);
        expect(JSON.parse(harness.adapter.files.get(`${TEST_CONFIG_DIR}/plugins/vault-coach/index-snapshot.json`) ?? "{}")).toMatchObject({
            stats: { fileCount: 2, chunkCount: 2 },
            vectorStats: { ready: false },
        });

        vectorBuild.resolve({ ready: true, vectorCount: 2, dimension: 384, lastBuiltAt: 1, compatibility: "compatible" });
        await ready;
        expect(readySettled).toBe(true);
        await fullRebuild;
        await harness.runtime.dispose();
    });

    // 验证冷启动期间的多个 readiness 请求会共享同一个文本构建任务，而不会重复扫描。
    it("joins a concurrent readiness request to the first text build", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        const originalRuntimeRebuild = harness.runtime.rebuildKnowledgeBase.bind(harness.runtime);
        let fullRebuild: Promise<void> | null = null;
        vi.spyOn(harness.runtime, "rebuildKnowledgeBase").mockImplementation((showNotice, signal) => {
            const rebuild = originalRuntimeRebuild(showNotice, signal);
            fullRebuild ??= rebuild;
            return rebuild;
        });
        const services = getIndexServices(harness.runtime);
        const textBuild = createDeferred<void>();
        const originalRebuild = services.knowledgeBase.rebuildIndexDetailed.bind(services.knowledgeBase);
        const rebuildText = vi.spyOn(services.knowledgeBase, "rebuildIndexDetailed")
            .mockImplementation(async (signal?: AbortSignal) => {
                await textBuild.promise;
                return await originalRebuild(signal);
            });
        let firstSettled = false;
        const first = harness.runtime.ensureKnowledgeBaseReady().then(() => { firstSettled = true; });

        await waitFor(() => rebuildText.mock.calls.length === 1);
        let secondSettled = false;
        const second = harness.runtime.ensureKnowledgeBaseReady().then(() => { secondSettled = true; });
        await Promise.resolve();

        expect(firstSettled).toBe(false);
        expect(secondSettled).toBe(false);

        textBuild.resolve();
        await Promise.all([first, second]);
        expect(secondSettled).toBe(true);
        await fullRebuild;
        await harness.runtime.dispose();
    });

    // 验证替换索引在 staging 期间不会清空旧 active CoreIndex，查询始终读到完整代际。
    it("keeps the active text index available while a replacement rebuild is staged", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        expect(harness.runtime.getKnowledgeBaseStats()).toMatchObject({ fileCount: 2, chunkCount: 2 });

        const readBarrier = createDeferred<void>();
        let readStarted = false;
        harness.setReadBarrier(readBarrier.promise, () => { readStarted = true; });
        const rebuilding = harness.runtime.rebuildKnowledgeBase(false);

        await waitFor(() => readStarted);
        expect(harness.runtime.getKnowledgeBaseStats()).toMatchObject({ fileCount: 2, chunkCount: 2 });

        readBarrier.resolve();
        await rebuilding;
        expect(harness.runtime.getKnowledgeBaseStats()).toMatchObject({ fileCount: 2, chunkCount: 2 });
        await harness.runtime.dispose();
    });
});

// 图谱重建集成测试：验证图谱失败或向量降级不会破坏已经可用的文本索引。
describe("VaultCoachRuntime graph rebuild integration", () => {
    // 验证文本重建成功后会生成确定性图谱，并把图谱 snapshot 持久化。
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

    // 验证图谱持久化失败时，文本索引仍保持成功状态并可继续使用。
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

    // 验证向量构建失败并回退 keyword 后，确定性图谱仍会继续构建。
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

    // 验证 Vault 重命名的增量同步会同时迁移图谱中的文档链接。
    it("migrates graph links during the same incremental sync that handles a Vault rename", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        harness.renameKnowledgeFile("details.md", "renamed-details.md");

        harness.runtime.handleVaultPathRenamed("details.md", "renamed-details.md");
        await flushPendingKnowledgeBaseSync(harness.runtime);

        const snapshot = await harness.runtime.application.graph.getSnapshot();
        const link = snapshot?.edges.find((edge) => edge.type === "links_to");
        expect(snapshot?.nodes.some((node) => node.id === "markdown:details.md")).toBe(false);
        expect(snapshot?.nodes.some((node) => node.id === "markdown:renamed-details.md")).toBe(true);
        expect(link).toMatchObject({
            targetNodeId: "markdown:renamed-details.md",
            sources: [expect.objectContaining({ targetFilePath: "renamed-details.md" })],
        });
        expect(await harness.runtime.application.graph.checkIntegrity()).toEqual({ valid: true, issues: [] });

        await harness.runtime.dispose();
    });

    // 验证修改、重命名、删除连续发生时，图谱查询结果和完整性检查仍然正确。
    it("keeps graph queries and integrity correct through modify, rename, and delete", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        const initialOverview = await harness.runtime.application.graph.getNode("markdown:overview.md");
        if (!initialOverview || initialOverview.type !== "document") throw new Error("Expected initial overview document.");

        harness.writeKnowledgeFile("overview.md", "# Overview\n\nUpdated retrieval notes.\n\n[[details]]");
        harness.runtime.handleVaultPathChanged("overview.md");
        await flushPendingKnowledgeBaseSync(harness.runtime);

        const updatedOverview = await harness.runtime.application.graph.getNode("markdown:overview.md");
        expect(updatedOverview).toMatchObject({ type: "document", filePath: "overview.md" });
        expect(updatedOverview?.type === "document" && updatedOverview.contentHash).not.toBe(initialOverview.contentHash);
        expect(await harness.runtime.application.graph.findNodesByDocumentPath("overview.md"))
            .toEqual(expect.arrayContaining([expect.objectContaining({ type: "document" })]));
        expect(await harness.runtime.application.graph.findEdgesBySourceFile("overview.md"))
            .toEqual(expect.arrayContaining([expect.objectContaining({ type: "links_to" })]));

        harness.renameKnowledgeFile("details.md", "renamed-details.md");
        harness.runtime.handleVaultPathRenamed("details.md", "renamed-details.md");
        await flushPendingKnowledgeBaseSync(harness.runtime);

        expect(await harness.runtime.application.graph.findEdgesForNode("markdown:renamed-details.md"))
            .toEqual(expect.arrayContaining([expect.objectContaining({ type: "links_to" })]));

        harness.deleteKnowledgeFile("renamed-details.md");
        harness.runtime.handleVaultPathChanged("renamed-details.md");
        await flushPendingKnowledgeBaseSync(harness.runtime);

        expect(await harness.runtime.application.graph.findNodesByDocumentPath("renamed-details.md")).toEqual([]);
        expect(await harness.runtime.application.graph.findEdgesBySourceFile("overview.md"))
            .not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "links_to" })]));
        expect(await harness.runtime.application.graph.checkIntegrity()).toEqual({ valid: true, issues: [] });
        await harness.runtime.dispose();
    });

    // 验证重复文件事件会去重，并优先走图谱增量同步而不是整图重建。
    it("deduplicates repeated file events and does not fall back to a graph full rebuild", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        const graphService = getGraphService(harness.runtime);
        const graphSync = vi.spyOn(graphService, "syncChangedFiles");
        const graphRebuild = vi.spyOn(graphService, "rebuildAll");

        harness.runtime.handleVaultPathChanged("overview.md");
        harness.runtime.handleVaultPathChanged("overview.md");
        await flushPendingKnowledgeBaseSync(harness.runtime);

        expect(graphSync).toHaveBeenCalledOnce();
        expect(graphSync.mock.calls[0]?.[0].affectedFiles).toEqual(["overview.md"]);
        expect(graphRebuild).not.toHaveBeenCalled();
        await harness.runtime.dispose();
    });

    // 验证插件自己的 snapshot 文件变化不会再次触发知识图谱更新。
    it("ignores VaultCoach internal-file events without scheduling a graph update", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        const graphService = getGraphService(harness.runtime);
        const graphSync = vi.spyOn(graphService, "syncChangedFiles");

        harness.runtime.handleVaultPathChanged(".vault-coach/graph/graph-snapshot-v1.json");
        await flushPendingKnowledgeBaseSync(harness.runtime);

        expect(graphSync).not.toHaveBeenCalled();
        expect(graphService.getState().dirty).toBe(false);
        await harness.runtime.dispose();
    });

    // 验证清理知识索引时会同步清理图谱，但保留考试等不属于索引的用户数据。
    it("clears the persisted and in-memory graph together with the knowledge index", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        const assessmentPath = ".vault-coach/assessments/sessions/exam-1.json";
        harness.adapter.files.set(assessmentPath, "{\"preserve\":true}");

        await harness.runtime.clearKnowledgeIndex(false);

        expect(await harness.runtime.application.graph.getSnapshot()).toBeNull();
        expect(harness.adapter.files.has(GRAPH_SNAPSHOT_PATH)).toBe(false);
        expect(harness.adapter.files.get(assessmentPath)).toBe("{\"preserve\":true}");
        await harness.runtime.dispose();
    });

    // 验证插件离线期间 Vault 发生变化后，不会恢复过期的派生向量/图谱数据。
    it("does not hydrate stale derived data after an offline Vault change", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        await harness.runtime.dispose();
        harness.deleteKnowledgeFile("details.md");

        const restarted = harness.restart();
        await restarted.initialize();

        expect(restarted.getSourceInventoryStatus()).toBe("source-sync-required");
        expect(restarted.isTextIndexDirty()).toBe(true);
        expect(restarted.getKnowledgeBaseStats()).toMatchObject({ fileCount: 0, chunkCount: 0 });
        expect(await restarted.application.graph.getSnapshot()).toBeNull();
        expect(restarted.application.semanticGraph.getState().hasData).toBe(false);
        expect(restarted.application.mastery.getSnapshot()).toBeNull();
        await restarted.dispose();
    });

    // 验证缺少 source inventory 的旧 snapshot 会被判定为过期，而不是直接恢复。
    it("treats a snapshot from before source inventories as stale rather than hydrating it", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        await harness.runtime.dispose();
        const snapshotPath = `${TEST_CONFIG_DIR}/plugins/vault-coach/index-snapshot.json`;
        const snapshot: unknown = JSON.parse(harness.adapter.files.get(snapshotPath) ?? "{}");
        if (!isRecord(snapshot)) throw new Error("Expected a persisted index snapshot.");
        delete snapshot.sourceInventory;
        snapshot.version = 2;
        harness.adapter.files.set(snapshotPath, JSON.stringify(snapshot));

        const restarted = harness.restart();
        await restarted.initialize();

        expect(restarted.getSourceInventoryStatus()).toBe("source-sync-required");
        expect(restarted.isTextIndexDirty()).toBe(true);
        expect(await restarted.application.graph.getSnapshot()).toBeNull();
        await restarted.dispose();
    });

    // 验证离线替换 Vault 可能意味着知识域切换，重建后应清理旧语义缓存和掌握度缓存。
    it("classifies an offline replacement as a possible domain switch and removes stale semantic/mastery caches after rebuilding", async () => {
        const harness = createRuntimeHarness();
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        await harness.runtime.dispose();
        harness.deleteKnowledgeFile("details.md");
        harness.deleteKnowledgeFile("overview.md");
        harness.addKnowledgeFile("database.md", "# Database\n\nA new unrelated domain.");

        const restarted = harness.restart();
        await restarted.initialize();
        expect(restarted.getSourceInventoryStatus()).toBe("possible-domain-switch");

        await restarted.rebuildKnowledgeBase(false);

        expect(restarted.getSourceInventoryStatus()).toBe("ready");
        expect(restarted.getKnowledgeBaseStats()).toMatchObject({ fileCount: 1, chunkCount: 1 });
        expect(await restarted.application.graph.getSnapshot()).toMatchObject({ stats: { documentCount: 1 } });
        expect(restarted.application.mastery.getSnapshot()).toBeNull();
        await restarted.dispose();
    });
});

// 知识范围设置测试：验证范围变更的校验、持久化和 dirty 状态传播。
describe("VaultCoachRuntime knowledge scope settings", () => {
    // 验证设置页只展示可选择的文件夹，同时兼容已有的深层历史配置。
    it("lists only selectable folders while preserving a deep legacy selection", async () => {
        const harness = createRuntimeHarness();
        harness.settings.knowledgeScopeMode = "specificFolder";
        harness.settings.knowledgeFolder = "研究/课程/2025";
        harness.setFolders(["研究", "研究/课程", "研究/课程/2025", ".vault-coach/graph"]);
        await harness.runtime.initialize();

        const options = harness.runtime.listKnowledgeScopeOptions();

        expect(options.map((option) => option.kind === "whole-vault" ? option.id : option.path)).toEqual([
            "whole-vault",
            "研究/课程/2025",
            "研究",
            "研究/课程",
        ]);
        expect(options[1]).toMatchObject({ kind: "legacy-folder", exists: true, selected: true });
        await harness.runtime.dispose();
    });

    // 验证范围变更只保存一次，并且只有持久化成功后才标记索引需要重建。
    it("saves a changed scope once and marks the index dirty only after persistence succeeds", async () => {
        const harness = createRuntimeHarness();
        harness.setFolders(["项目", "项目/AI"]);
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);

        await harness.runtime.updateKnowledgeScope({ kind: "folder", path: " 项目\\AI/ " });

        expect(harness.settings).toMatchObject({
            knowledgeScopeMode: "specificFolder",
            knowledgeFolder: "项目/AI",
        });
        expect(harness.saveSettings).toHaveBeenCalledOnce();
        expect(harness.runtime.isTextIndexDirty()).toBe(true);
        await harness.runtime.dispose();
    });

    // 验证切换 whole Vault 时保留上次文件夹，并跳过没有实际变化的重复选择。
    it("retains the previous folder when switching to the whole Vault and skips repeated choices", async () => {
        const harness = createRuntimeHarness();
        harness.settings.knowledgeScopeMode = "specificFolder";
        harness.settings.knowledgeFolder = "项目/AI";
        await harness.runtime.initialize();

        await harness.runtime.updateKnowledgeScope({ kind: "whole-vault" });
        await harness.runtime.updateKnowledgeScope({ kind: "whole-vault" });

        expect(harness.settings.knowledgeScopeMode).toBe("wholeVault");
        expect(harness.settings.knowledgeFolder).toBe("项目/AI");
        expect(harness.saveSettings).toHaveBeenCalledOnce();
        await harness.runtime.dispose();
    });

    // 验证设置持久化失败时同时回滚相关字段，且不污染原本干净的索引状态。
    it("rolls back both fields and leaves a clean index clean when persistence fails", async () => {
        const harness = createRuntimeHarness();
        harness.setFolders(["项目", "项目/AI"]);
        await harness.runtime.initialize();
        await harness.runtime.rebuildKnowledgeBase(false);
        harness.saveSettings.mockRejectedValueOnce(new Error("disk unavailable"));

        await expect(harness.runtime.updateKnowledgeScope({ kind: "folder", path: "项目/AI" }))
            .rejects.toThrow("disk unavailable");

        expect(harness.settings.knowledgeScopeMode).toBe("wholeVault");
        expect(harness.settings.knowledgeFolder).toBe("");
        expect(harness.runtime.isTextIndexDirty()).toBe(false);
        await harness.runtime.dispose();
    });

    // 验证不存在或层级过深的新文件夹会在写入设置前被拒绝。
    it("rejects missing or deep new folders before persistence", async () => {
        const harness = createRuntimeHarness();
        harness.setFolders(["项目", "项目/AI", "项目/AI/论文"]);
        await harness.runtime.initialize();

        await expect(harness.runtime.updateKnowledgeScope({ kind: "folder", path: "项目/AI/论文" }))
            .rejects.toThrow("第一层或第二层");
        await expect(harness.runtime.updateKnowledgeScope({ kind: "folder", path: "不存在" }))
            .rejects.toThrow("第一层或第二层");

        expect(harness.saveSettings).not.toHaveBeenCalled();
        expect(harness.settings.knowledgeScopeMode).toBe("wholeVault");
        await harness.runtime.dispose();
    });
});

/**
 * 创建完全在内存中的 Runtime 测试环境，模拟 Vault 文件、Obsidian adapter、设置和服务容器。
 * 通过这个 harness，测试可以控制读写、重命名、删除以及 deferred 读取，而不触碰真实用户 Vault。
 */
function createRuntimeHarness(failWrite: ((path: string) => boolean) | null = null): {
    runtime: VaultCoachRuntime;
    adapter: InMemoryVaultAdapter;
    settings: VaultCoachSettings;
    saveSettings: ReturnType<typeof vi.fn>;
    setFolders(paths: string[]): void;
    renameKnowledgeFile(oldPath: string, newPath: string): void;
    writeKnowledgeFile(path: string, content: string): void;
    deleteKnowledgeFile(path: string): void;
    addKnowledgeFile(path: string, content: string): void;
    setReadBarrier(barrier: Promise<void> | null, onReadStarted?: () => void): void;
    restart(): VaultCoachRuntime;
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
    let folderPaths: string[] = [];
    let readBarrier: Promise<void> | null = null;
    let onReadStarted: (() => void) | undefined;
    // app 中的这些回调是 Runtime 依赖的最小 Obsidian API；readBarrier 用来暂停 staging 读取。
    const app = {
        vault: {
            configDir: TEST_CONFIG_DIR,
            adapter,
            getFiles: (): TFile[] => Array.from(files.values()).map((entry) => entry.file),
            getAllFolders: () => [
                { path: "/", isRoot: () => true },
                ...folderPaths.map((path) => ({ path, isRoot: () => false })),
            ],
            getAbstractFileByPath: (path: string): TFile | null => files.get(normalizePath(path))?.file ?? null,
            cachedRead: async (file: TFile): Promise<string> => {
                onReadStarted?.();
                if (readBarrier) await readBarrier;
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
    const saveSettings = vi.fn(async () => undefined);
    const host: VaultCoachRuntimeHost = {
        app,
        pluginId: "vault-coach",
        getSettings: () => settings,
        saveSettings,
        onStateChanged: () => undefined,
        showNotice: () => undefined,
        translate: (key) => key,
    };

    const createRuntime = () => new VaultCoachRuntime(host);
    return {
        runtime: createRuntime(),
        adapter,
        settings,
        saveSettings,
        // 更新模拟 Vault 的文件夹列表，供知识范围设置测试使用。
        setFolders: (paths) => { folderPaths = [...paths]; },
        // 在内存文件表中执行 Vault 重命名，并更新时间戳以模拟真实文件变化。
        renameKnowledgeFile: (oldPath, newPath) => {
            const entry = files.get(oldPath);
            if (!entry) throw new Error(`Missing fixture file: ${oldPath}`);
            files.delete(oldPath);
            files.set(newPath, {
                file: createFile(newPath, entry.file.stat.mtime + 1),
                content: entry.content,
            });
        },
        // 修改一个模拟 Markdown 文件，同时递增 mtime 让增量同步识别到变化。
        writeKnowledgeFile: (path, content) => {
            const entry = files.get(path);
            if (!entry) throw new Error(`Missing fixture file: ${path}`);
            files.set(path, {
                file: createFile(path, entry.file.stat.mtime + 1),
                content,
            });
        },
        // 删除模拟 Vault 文件；目标不存在时主动报错，避免测试静默失效。
        deleteKnowledgeFile: (path) => {
            if (!files.delete(path)) throw new Error(`Missing fixture file: ${path}`);
        },
        // 添加新的模拟 Markdown 文件，并拒绝覆盖已有 fixture。
        addKnowledgeFile: (path, content) => {
            if (files.has(path)) throw new Error(`Existing fixture file: ${path}`);
            files.set(path, { file: createFile(path, Date.now()), content });
        },
        // 设置异步读取屏障，用于观察 replacement rebuild 的 staging 阶段。
        setReadBarrier: (barrier, onStarted) => {
            readBarrier = barrier;
            onReadStarted = onStarted;
        },
        restart: createRuntime,
    };
}

/** 直接调用 Runtime 的待处理增量同步，用于等待文件事件对应的后台刷新完成。 */
function flushPendingKnowledgeBaseSync(runtime: VaultCoachRuntime): Promise<void> {
    return (runtime as unknown as {
        flushPendingKnowledgeBaseSync(showNotice: boolean): Promise<void>;
    }).flushPendingKnowledgeBaseSync(false);
}

/** 从 Runtime 的内部容器取出图谱服务，便于断言增量同步和完整性结果。 */
function getGraphService(runtime: VaultCoachRuntime): KnowledgeGraphService {
    return (runtime as unknown as {
        applicationContainer: { services: { knowledgeGraphService: KnowledgeGraphService } };
    }).applicationContainer.services.knowledgeGraphService;
}

/** 从 Runtime 的内部容器取出文本索引和向量索引服务，便于注入 deferred 或失败行为。 */
function getIndexServices(runtime: VaultCoachRuntime): {
    knowledgeBase: { rebuildIndexDetailed(signal?: AbortSignal): Promise<unknown> };
    ragEngine: { rebuildVectorIndex(signal?: AbortSignal): Promise<unknown> };
} {
    return (runtime as unknown as {
        applicationContainer: {
            services: {
                knowledgeBase: { rebuildIndexDetailed(signal?: AbortSignal): Promise<unknown> };
                ragEngine: { rebuildVectorIndex(signal?: AbortSignal): Promise<unknown> };
            };
        };
    }).applicationContainer.services;
}

/** 创建一个由测试手动 resolve 的 Promise，用来模拟向量/文本任务尚未完成的状态。 */
function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve };
}

/** 在若干个 microtask 中等待异步 fixture 到达目标状态，超时则让测试明确失败。 */
async function waitFor(predicate: () => boolean, attempts: number = 30): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error("Timed out waiting for test fixture state.");
}

class InMemoryVaultAdapter {
    readonly files = new Map<string, string>();
    readonly directories = new Set<string>();

    constructor(private readonly failWrite: ((path: string) => boolean) | null) {}

    /** 判断模拟文件或目录是否存在。 */
    async exists(path: string): Promise<boolean> {
        return this.files.has(path) || this.directories.has(path);
    }

    /** 读取模拟文本文件，不存在时抛错以暴露错误路径。 */
    async read(path: string): Promise<string> {
        const content = this.files.get(path);
        if (content === undefined) throw new Error(`Missing stored fixture: ${path}`);
        return content;
    }

    /** 将模拟文本编码为 ArrayBuffer，覆盖插件的二进制读取接口。 */
    async readBinary(path: string): Promise<ArrayBuffer> {
        const content = await this.read(path);
        return new TextEncoder().encode(content).buffer;
    }

    /** 写入模拟文本文件，并可按路径注入持久化失败。 */
    async write(path: string, content: string): Promise<void> {
        if (this.failWrite?.(path)) throw new Error(`Refused fixture write: ${path}`);
        this.files.set(path, content);
    }

    /** 写入模拟二进制文件，使用 TextDecoder 便于测试读取持久化内容。 */
    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        if (this.failWrite?.(path)) throw new Error(`Refused fixture write: ${path}`);
        this.files.set(path, new TextDecoder().decode(data));
    }

    /** 创建模拟目录；测试只需记录目录存在性。 */
    async mkdir(path: string): Promise<void> {
        this.directories.add(path);
    }

    /** 原子地移动模拟文件，并拒绝覆盖目标文件。 */
    async rename(oldPath: string, newPath: string): Promise<void> {
        if (this.files.has(newPath)) throw new Error(`Destination file already exists: ${newPath}`);
        const content = await this.read(oldPath);
        this.files.set(newPath, content);
        this.files.delete(oldPath);
    }

    /** 删除一个模拟文件或目录。 */
    async remove(path: string): Promise<void> {
        this.files.delete(path);
        this.directories.delete(path);
    }

    /** 删除目录；recursive=true 时同时删除其路径前缀下的全部 fixture。 */
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

/** 创建带有稳定路径、扩展名和 mtime 的最小 Obsidian TFile fixture。 */
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

/** 判断未知值是否为非 null 对象，供 snapshot 结构断言使用。 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
