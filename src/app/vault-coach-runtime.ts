import { normalizePath, type App } from "obsidian";
import { createApplicationContainer, type ApplicationContainer } from "./application-container";
import { getDefaultGreeting, isBuiltInDefaultGreeting, type TranslationKey } from "../i18n";
import { isAbortError } from "../utils/errors";
import type { KnowledgeBaseStats, KnowledgeBaseSyncResult } from "../domain/documents/document-types";
import type { PersistedPluginState, KnowledgeBaseSnapshot } from "../infrastructure/storage/storage-types";
import type { KnowledgeIndexBusyPhase, KnowledgeIndexBusyState } from "./index/index-types";
import type { RetrievalPreference, RetrievalResolution, VectorIndexStats } from "../domain/retrieval/retrieval-types";
import { resolveRetrievalMode } from "./retrieval/retrieval-mode-resolver";
import type { VaultCoachSettings } from "./config/settings-types";
import { buildKnowledgeScopeOptions } from "./knowledge/knowledge-scope-catalog";
import type {
    KnowledgeScopeOption,
    KnowledgeScopeSelection,
    VaultFolderSnapshot,
} from "./knowledge/knowledge-scope-types";
import type { ExamScopeSelection } from "../domain/exam/exam-types";
import type { GraphRename } from "../domain/graph/graph-types";
import type { StorageFootprint, StorageFootprintCategory } from "../domain/index-lifecycle/storage-footprint";
import {
    getSourceInventoryStatus,
    type SourceInventoryDiff,
    type SourceInventoryStatus,
} from "../domain/index-lifecycle/source-inventory";
import { isVaultCoachHiddenPath, normalizeVaultPath } from "../domain/documents/vault-path";
import type { LocalAiStatus } from "../domain/local-ai/local-ai-types";
import { createCoreGenerationId } from "../domain/index-lifecycle/index-generation";
import type { VectorBuildJob } from "../domain/index-jobs/vector-build-job";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/** 运行时访问 Obsidian 和插件 UI 的最小宿主边界。 */
export interface VaultCoachRuntimeHost {
    app: App;
    pluginId: string;
    getSettings(): VaultCoachSettings;
    saveSettings(): Promise<void>;
    onStateChanged(): void;
    showNotice(message: string, timeout?: number): void;
    translate: TranslateFn;
}

interface IndexOperation {
    signal: AbortSignal;
    ownsController: boolean;
}

interface CoreReadinessTask {
    promise: Promise<void>;
    resolve(): void;
    reject(reason: unknown): void;
    settled: boolean;
}

/**
 * 管理应用服务及全部非 UI 运行时状态。
 *
 * 本类不感知 `WorkspaceLeaf`、`ItemView`、插件注册或设置界面。
 * 插件生命周期负责转发 Vault 事件，并通过 host 提供最小化的 Obsidian 通知与刷新适配器。
 */
export class VaultCoachRuntime {
    private applicationContainer!: ApplicationContainer;
    private unsubscribeApplicationEvents: (() => void) | null = null;
    private readonly pendingChangedKnowledgePaths = new Set<string>();
    private readonly pendingGraphRenames = new Map<string, string>();
    private autoIndexDebounceTimer: number | null = null;
    private autoIndexMaxWaitTimer: number | null = null;
    private isSyncingKnowledgeBase = false;
    private lastAutoIndexAt: number | null = null;
    private hasShownOllamaEmbeddingCpuFallbackNotice = false;
    private sourceInventoryStatus: SourceInventoryStatus = "not-indexed";
    private sourceInventoryDiff: SourceInventoryDiff | null = null;
    private activeCoreReadiness: CoreReadinessTask | null = null;
    /** 文件事件可安全继续服务旧 Core；范围、解析策略等改变必须等待新 Core。 */
    private coreRefreshRequiresFresh = true;
    private readonly backgroundDerivedTasks = new Set<Promise<void>>();
    private disposing = false;

    constructor(private readonly host: VaultCoachRuntimeHost) {}

    async initialize(): Promise<void> {
        this.applicationContainer = createApplicationContainer({
            app: this.host.app,
            pluginId: this.host.pluginId,
            getSettings: () => this.settings,
            getCloudApiKey: () => this.getCloudApiKey(),
            getDefaultGreeting: () => this.getEffectiveDefaultGreeting(),
            getKnowledgeScopeDescription: () => this.getKnowledgeScopeDescription(),
            ensureKnowledgeBaseReady: () => this.ensureKnowledgeBaseReady(),
            persistRuntimeState: () => this.persistRuntimeState(),
            onGenerationFinished: () => this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded(),
            translate: this.host.translate,
            getFullScopeLabel: () => this.t("exam.scope.fullCurrentKnowledgeBase"),
            getNoEligibleChunksMessage: () => this.t("exam.notice.noChunks"),
            normalizeFolderPaths: (folderPaths) => this.normalizeExamFolderPaths(folderPaths),
            normalizeSelection: (selection) => this.normalizeExamScopeSelection(selection),
            getIndexState: () => ({
                textDirty: this.isTextIndexDirty(),
                vectorDirty: this.isVectorIndexDirty(),
                sourceInventoryStatus: this.sourceInventoryStatus,
                sourceInventoryDiff: this.cloneSourceInventoryDiff(),
                busy: this.getKnowledgeIndexBusyState(),
                stats: this.getKnowledgeBaseStats(),
                vectorStats: this.getVectorIndexStats(),
                vectorJob: this.services.vectorBuildCoordinator.getState(),
            }),
            rebuildIndex: (signal) => this.rebuildKnowledgeBase(false, signal),
            clearIndex: () => this.clearKnowledgeIndex(false),
            abortIndex: () => this.abortKnowledgeIndexBuild(false),
            getStorageFootprint: () => this.getStorageFootprint(),
            getActiveCoreGenerationId: () => this.getActiveCoreGenerationId(),
        });
        this.unsubscribeApplicationEvents = this.applicationContainer.application.subscribe(() => this.host.onStateChanged());

        await this.restorePersistentState();
        const canHydrateDerivedData = await this.restoreKnowledgeBaseSnapshot();
        if (canHydrateDerivedData) {
            await this.services.knowledgeGraphService.load();
            await this.services.semanticGraphService.load();
            await this.services.masteryService.load();
        }
        if (this.services.knowledgeBase.isReady() && !this.services.knowledgeGraphService.getState().hasSnapshot) {
            this.services.knowledgeGraphService.markDirty();
            this.services.masteryService.markDirty("确定性知识图谱尚未建立，需要重新计算掌握度。");
        }
        const restoredVectorJob = await this.services.vectorBuildCoordinator.restore();
        if (restoredVectorJob && !isTerminalVectorJob(restoredVectorJob)) {
            this.trackBackgroundTask(this.finishFullDerivedIndexes(restoredVectorJob, false));
        } else if (restoredVectorJob) {
            this.applyVectorJobTerminal(restoredVectorJob);
        }
        if (this.services.chatService.getMessages().length === 0) {
            this.applicationContainer.application.chat.resetConversation();
        }
    }

    async dispose(): Promise<void> {
        this.disposing = true;
        this.abortKnowledgeIndexBuild(false);
        this.services.vectorBuildCoordinator.cancel();
        this.clearAutoIndexTimers();
        this.unsubscribeApplicationEvents?.();
        this.unsubscribeApplicationEvents = null;
        await Promise.allSettled(Array.from(this.backgroundDerivedTasks));
        await this.applicationContainer.dispose();
    }

    get application() {
        return this.applicationContainer.application;
    }

    getEffectiveDefaultGreeting(): string {
        const configuredGreeting = this.settings.defaultGreeting.trim();
        return configuredGreeting.length === 0 || isBuiltInDefaultGreeting(configuredGreeting)
            ? getDefaultGreeting()
            : this.settings.defaultGreeting;
    }

    markKnowledgeBaseDirty(requireFreshCore: boolean = true): void {
        this.coreRefreshRequiresFresh ||= requireFreshCore;
        this.knowledgeBaseDirty = true;
        this.vectorIndexDirty = true;
        this.services.knowledgeGraphService.markDirty();
        this.services.masteryService.markDirty("知识库范围已变更，需要重新计算掌握度。");
    }

    markVectorIndexDirty(): void {
        const current = this.services.ragEngine.getVectorIndexStats();
        this.services.ragEngine.hydrateVectorStats({
            ...current,
            ready: false,
            compatibility: current.vectorCount > 0 ? "stale" : "absent",
        });
        this.vectorIndexDirty = this.settings.enableVectorRetrieval;
    }

    isTextIndexDirty(): boolean {
        return this.knowledgeBaseDirty;
    }

    isVectorIndexDirty(): boolean {
        return this.vectorIndexDirty;
    }

    getKnowledgeIndexBusyState(): KnowledgeIndexBusyState {
        return this.services.indexCoordinator.getBusyState();
    }

    getKnowledgeBaseStats(): KnowledgeBaseStats {
        return this.services.knowledgeBase.getStats();
    }

    getVectorIndexStats(): VectorIndexStats {
        return this.services.ragEngine.getVectorIndexStats();
    }

    getLocalAiStatus(): LocalAiStatus {
        return this.services.localAIRuntime.getStatus();
    }

    subscribeLocalAiStatus(listener: (status: LocalAiStatus) => void): () => void {
        return this.services.localAIRuntime.subscribe(listener);
    }

    async prepareBuiltinEmbedding(): Promise<void> {
        await this.services.localAIRuntime.prepare(true);
        this.host.onStateChanged();
    }

    async clearBuiltinEmbedding(): Promise<void> {
        await this.services.localAIRuntime.clear();
        this.host.onStateChanged();
    }

    getSourceInventoryStatus(): SourceInventoryStatus {
        return this.sourceInventoryStatus;
    }

    getSourceInventoryDiff(): SourceInventoryDiff | null {
        return this.cloneSourceInventoryDiff();
    }

    async getStorageFootprint(): Promise<StorageFootprint> {
        const footprint = await this.services.storageFootprintReporter.getFootprint();
        const graphSnapshot = this.services.knowledgeGraphService.getSnapshot();
        const semanticStats = this.services.semanticGraphService.getState().stats;
        const masterySnapshot = this.services.masteryService.getSnapshot();
        const recordCounts: Partial<Record<StorageFootprintCategory, number>> = {
            "text-index": this.services.knowledgeBase.getStats().chunkCount,
            "vector-index": this.services.ragEngine.getVectorIndexStats().vectorCount,
            "deterministic-graph": graphSnapshot ? graphSnapshot.nodes.length + graphSnapshot.edges.length : 0,
            "semantic-facts": semanticStats.extractionCount + semanticStats.conceptCount + semanticStats.candidateCount,
            "semantic-embeddings": semanticStats.embeddingCount,
            mastery: masterySnapshot?.states.length ?? 0,
        };
        return {
            ...footprint,
            entries: footprint.entries.map((entry) => ({
                ...entry,
                recordCount: recordCounts[entry.category] ?? null,
            })),
        };
    }

    getKnowledgeScopeDescription(): string {
        return this.getKnowledgeBaseStats().scopeDescription;
    }

    getLocalizedKnowledgeScopeDescription(): string {
        if (this.settings.knowledgeScopeMode === "wholeVault") {
            return this.t("scope.wholeVault");
        }
        const folderPath = this.settings.knowledgeFolder.trim().replace(/\/$/, "");
        return folderPath.length === 0 ? this.t("scope.folderUnset") : this.t("scope.folder", { folder: folderPath });
    }

    /** 返回当前设置对应的单一 UI 范围，不修改旧的持久化字段。 */
    getKnowledgeScopeSelection(): KnowledgeScopeSelection {
        return this.settings.knowledgeScopeMode === "wholeVault"
            ? { kind: "whole-vault" }
            : { kind: "folder", path: normalizeVaultPath(this.settings.knowledgeFolder) };
    }

    /** 每次打开选择器时重新读取 Vault 目录，避免跨会话缓存已经失效的路径。 */
    listKnowledgeScopeOptions(): KnowledgeScopeOption[] {
        const folders: VaultFolderSnapshot[] = this.host.app.vault.getAllFolders(true).map((folder) => ({
            path: folder.path,
            isRoot: folder.isRoot(),
        }));
        return buildKnowledgeScopeOptions({
            folders,
            current: this.getKnowledgeScopeSelection(),
            maxSelectableDepth: 2,
        });
    }

    /**
     * 原子更新知识库范围。
     *
     * 保存成功后才使索引失效；保存失败会恢复两个旧字段，防止内存状态与 data.json 分裂。
     */
    async updateKnowledgeScope(selection: KnowledgeScopeSelection): Promise<void> {
        const normalizedSelection = normalizeKnowledgeScopeSelection(selection);
        const previousMode = this.settings.knowledgeScopeMode;
        const previousFolder = this.settings.knowledgeFolder;
        const previousSignature = getEffectiveKnowledgeScopeSignature(previousMode, previousFolder);
        const nextMode = normalizedSelection.kind === "whole-vault" ? "wholeVault" : "specificFolder";
        const nextFolder = normalizedSelection.kind === "whole-vault"
            ? previousFolder
            : normalizedSelection.path;
        const nextSignature = getEffectiveKnowledgeScopeSignature(nextMode, nextFolder);
        if (previousSignature === nextSignature) return;
        if (normalizedSelection.kind === "folder") {
            const isSelectableFolder = this.listKnowledgeScopeOptions().some((option) => {
                return option.kind === "folder" && option.path === normalizedSelection.path && option.exists;
            });
            if (!isSelectableFolder) {
                throw new Error("只能选择 Vault 中第一层或第二层的现有目录。");
            }
        }

        this.settings.knowledgeScopeMode = nextMode;
        this.settings.knowledgeFolder = nextFolder;
        try {
            await this.host.saveSettings();
        } catch (error: unknown) {
            this.settings.knowledgeScopeMode = previousMode;
            this.settings.knowledgeFolder = previousFolder;
            throw error;
        }
        this.markKnowledgeBaseDirty();
        this.host.onStateChanged();
    }

    getRuntimeRetrievalPreference(): RetrievalPreference {
        return this.services.chatService.getRuntimeRetrievalPreference();
    }

    setRuntimeRetrievalPreference(preference: RetrievalPreference): void {
        this.services.chatService.setRuntimeRetrievalPreference(preference);
        this.host.onStateChanged();
    }

    getRetrievalResolution(): RetrievalResolution {
        return this.services.chatService.getLastRetrievalResolution() ?? resolveRetrievalMode(
            this.services.chatService.getRuntimeRetrievalPreference(),
            {
                vectorEnabled: this.settings.enableVectorRetrieval,
                vectorReady: this.services.ragEngine.getVectorIndexStats().ready,
            },
        );
    }

    getActiveChatModelName(): string {
        return this.settings.modelProvider === "openai-compatible"
            ? this.settings.cloudChatModel.trim()
            : this.settings.chatModel.trim();
    }

    getActiveEmbeddingModelName(): string {
        if (this.settings.embeddingProvider === "builtin") return "multilingual-e5-small (built-in, uint8)";
        return this.settings.embeddingProvider === "openai-compatible"
            ? this.settings.cloudEmbeddingModel.trim()
            : this.settings.embeddingModel.trim();
    }

    getMemoryCount(): number {
        return this.services.memoryService.getCount();
    }

    async rebuildKnowledgeBase(showNotice: boolean, signal?: AbortSignal): Promise<void> {
        const operation = this.startKnowledgeIndexOperation("rebuilding", signal);
        if (!operation) {
            if (this.activeCoreReadiness) {
                await this.activeCoreReadiness.promise;
            }
            if (showNotice) this.notice("notice.index.alreadyBuilding");
            return;
        }
        const abortSignal = operation.signal;
        const coreReadiness = createCoreReadinessTask();
        this.activeCoreReadiness = coreReadiness;
        let textActivated = false;
        const sourceWasOutOfSync = this.sourceInventoryStatus !== "ready";
        try {
            abortSignal.throwIfAborted();
            const textSyncResult: KnowledgeBaseSyncResult = await this.services.knowledgeBase.rebuildIndexDetailed(abortSignal);
            const textStats = textSyncResult.stats;
            // 文本代际已经由 KnowledgeBase 原子激活；先使 keyword 可用，再继续派生索引。
            this.markActiveVectorIndexStale();
            this.vectorIndexDirty = this.settings.enableVectorRetrieval;
            this.services.knowledgeGraphService.markDirty();
            this.services.masteryService.markDirty("文本索引已更新，需要重新计算掌握度。");
            this.knowledgeBaseDirty = false;
            this.coreRefreshRequiresFresh = false;
            this.setSourceInventoryStatus("ready", null);
            await this.persistKnowledgeBaseSnapshot();
            textActivated = true;
            coreReadiness.resolve();

            abortSignal.throwIfAborted();
            const vectorJob = await this.enqueueVectorBuild();
            this.trackBackgroundTask(this.finishFullDerivedIndexes(vectorJob, sourceWasOutOfSync));
            if (showNotice) {
                const message = this.t("notice.index.complete", {
                    fileCount: textStats.fileCount,
                    chunkCount: textStats.chunkCount,
                    vectorInfo: "",
                });
                this.host.showNotice(message);
            }
        } catch (error: unknown) {
            if (!textActivated) {
                coreReadiness.reject(error);
                this.knowledgeBaseDirty = true;
                this.coreRefreshRequiresFresh = true;
            }
            if (isAbortError(error)) {
                console.warn("[VaultCoachRuntime] 索引构建已停止。", error);
                const retained = await this.services.vectorStore.getStats();
                this.services.ragEngine.hydrateVectorStats({
                    ready: false,
                    vectorCount: retained.vectorCount,
                    dimension: retained.dimension,
                    lastBuiltAt: retained.lastUpdatedAt,
                    compatibility: retained.vectorCount > 0 ? "stale" : "absent",
                });
                this.vectorIndexDirty = this.settings.enableVectorRetrieval;
                if (showNotice) this.notice("notice.index.stopped");
                return;
            }
            console.error("[VaultCoachRuntime] 重建索引失败", error);
            if (showNotice) this.notice("notice.index.rebuildFailed");
        } finally {
            if (!coreReadiness.settled) {
                coreReadiness.reject(new Error("Knowledge-base rebuild ended before the text index became ready."));
            }
            if (this.activeCoreReadiness === coreReadiness) {
                this.activeCoreReadiness = null;
            }
            this.finishKnowledgeIndexOperation(operation);
        }
    }

    async clearKnowledgeIndex(showNotice: boolean): Promise<void> {
        if (this.getKnowledgeIndexBusyState().busy) {
            if (showNotice) this.notice("notice.index.clearWhileBusy");
            return;
        }
        this.clearAutoIndexTimers();
        this.pendingChangedKnowledgePaths.clear();
        this.pendingGraphRenames.clear();
        await this.services.vectorBuildCoordinator.clear();
        this.services.knowledgeBase.clearIndexData();
        await this.services.vectorStore.clear();
        await this.services.persistentStore.removeKnowledgeBaseSnapshot();
        try {
            await this.services.knowledgeGraphService.clear();
            this.services.learningGraphQueryService.invalidate();
            this.services.masteryService.markDirty("知识图谱已清除，需要重新计算掌握度。");
        } catch (error: unknown) {
            this.services.knowledgeGraphService.markDirty();
            this.services.masteryService.markDirty("知识图谱清除未完成，需要重新计算掌握度。");
            console.error("[VaultCoachRuntime] 清除图谱快照失败，文本索引已清除。", error);
        }
        try {
            await this.services.semanticGraphService.clear();
            this.services.learningGraphQueryService.invalidate();
            this.services.masteryService.markDirty("语义概念图谱已清除，需要重新计算掌握度。");
        } catch (error: unknown) {
            this.services.masteryService.markDirty("语义图谱清除未完成，需要重新计算掌握度。");
            console.error("[VaultCoachRuntime] 清除语义图谱失败，文本索引已清除。", error);
        }
        try {
            await this.services.masteryService.clear();
        } catch (error: unknown) {
            this.services.masteryService.markDirty("掌握度快照清除未完成，需要重新计算。");
            console.error("[VaultCoachRuntime] 清除掌握度快照失败。", error);
        }
        this.services.ragEngine.hydrateVectorStats({ ready: false, vectorCount: 0, dimension: null, lastBuiltAt: null });
        this.knowledgeBaseDirty = false;
        this.vectorIndexDirty = false;
        this.setSourceInventoryStatus("not-indexed", null);
        this.lastAutoIndexAt = null;
        if (showNotice) this.notice("notice.index.cleared");
    }

    abortKnowledgeIndexBuild(showNotice: boolean): void {
        const controller = this.services.indexCoordinator.getActiveAbortController();
        const vectorJob = this.services.vectorBuildCoordinator.getState();
        const hasActiveVectorJob = vectorJob !== null && !isTerminalVectorJob(vectorJob);
        this.services.vectorBuildCoordinator.cancel();
        if (!controller || controller.signal.aborted) {
            if (showNotice) this.notice(hasActiveVectorJob ? "notice.index.stopRequested" : "notice.index.noActiveBuild");
            return;
        }
        controller.abort(new DOMException("VaultCoach index build aborted by user.", "AbortError"));
        if (showNotice) this.notice("notice.index.stopRequested");
    }

    async ensureKnowledgeBaseReady(): Promise<void> {
        const hasActiveCore = this.services.knowledgeBase.isReady();
        if (hasActiveCore && !this.knowledgeBaseDirty) {
            return;
        }

        if (hasActiveCore && !this.coreRefreshRequiresFresh) {
            // 普通 Vault 文件变更期间保留旧完整 Core 服务；自动同步或下一次显式重建会替换它。
            if (!this.activeCoreReadiness) {
                void this.rebuildKnowledgeBase(false);
            }
            return;
        }

        const rebuilding = this.rebuildKnowledgeBase(false);
        const coreReadiness = this.activeCoreReadiness;
        if (coreReadiness) {
            await coreReadiness.promise;
            return;
        }
        await rebuilding;
    }

    handleVaultPathChanged(path: string): void {
        if (!this.isKnowledgePath(path) || this.isVaultCoachHiddenPath(path)) return;
        this.pendingChangedKnowledgePaths.add(path);
        this.markKnowledgeBaseDirty(false);
        this.scheduleAutoIndexSync();
    }

    handleVaultPathRenamed(oldPath: string, newPath: string): void {
        if (
            (this.isKnowledgePath(oldPath) || this.isKnowledgePath(newPath))
            && !this.isVaultCoachHiddenPath(oldPath)
            && !this.isVaultCoachHiddenPath(newPath)
        ) {
            this.queueGraphRename(oldPath, newPath);
        }
        this.handleVaultPathChanged(oldPath);
        this.handleVaultPathChanged(newPath);
    }

    private get settings(): VaultCoachSettings {
        return this.host.getSettings();
    }

    private get services(): ApplicationContainer["services"] {
        return this.applicationContainer.services;
    }

    private get knowledgeBaseDirty(): boolean {
        return this.services.indexCoordinator.getTextDirty();
    }

    private set knowledgeBaseDirty(value: boolean) {
        this.services.indexCoordinator.setTextDirty(value);
    }

    private get vectorIndexDirty(): boolean {
        return this.services.indexCoordinator.getVectorDirty();
    }

    private set vectorIndexDirty(value: boolean) {
        this.services.indexCoordinator.setVectorDirty(value);
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return this.host.translate(key, replacements);
    }

    private notice(key: TranslationKey, replacements?: Record<string, string | number>): void {
        this.host.showNotice(this.t(key, replacements));
    }

    private getCloudApiKey(): string | null {
        const secretName = this.settings.cloudApiKeySecretName.trim();
        return secretName.length === 0 ? null : this.host.app.secretStorage.getSecret(secretName);
    }

    private setKnowledgeIndexBusy(phase: KnowledgeIndexBusyPhase): void {
        this.services.indexCoordinator.setBusy(phase);
    }

    private setKnowledgeIndexIdle(): void {
        this.services.indexCoordinator.setIdle();
    }

    private startKnowledgeIndexOperation(phase: KnowledgeIndexBusyPhase, signal?: AbortSignal): IndexOperation | null {
        if (!signal && this.getKnowledgeIndexBusyState().busy) return null;
        const controller = signal ? null : new AbortController();
        const operationSignal = signal ?? controller!.signal;
        if (controller) this.services.indexCoordinator.setActiveAbortController(controller);
        this.setKnowledgeIndexBusy(phase);
        return { signal: operationSignal, ownsController: controller !== null };
    }

    private finishKnowledgeIndexOperation(operation: IndexOperation): void {
        if (!operation.ownsController) return;
        if (this.services.indexCoordinator.getActiveAbortController()?.signal === operation.signal) {
            this.services.indexCoordinator.setActiveAbortController(null);
        }
        this.setKnowledgeIndexIdle();
    }

    private scheduleAutoIndexSync(): void {
        if (!this.settings.enableAutoIndexSync) return;
        if (this.pendingChangedKnowledgePaths.size >= this.settings.autoIndexFileThreshold) {
            void this.flushPendingKnowledgeBaseSync(false);
            return;
        }
        if (this.autoIndexDebounceTimer !== null) window.clearTimeout(this.autoIndexDebounceTimer);
        this.autoIndexDebounceTimer = window.setTimeout(() => void this.flushPendingKnowledgeBaseSync(false), this.settings.autoIndexDebounceMs);
        if (this.autoIndexMaxWaitTimer === null) {
            this.autoIndexMaxWaitTimer = window.setTimeout(() => void this.flushPendingKnowledgeBaseSync(false), this.settings.autoIndexMaxWaitMs);
        }
    }

    private async flushPendingKnowledgeBaseSync(showNotice: boolean): Promise<void> {
        if (this.isSyncingKnowledgeBase) return;
        const filePaths = Array.from(this.pendingChangedKnowledgePaths);
        const graphRenames = this.getPendingGraphRenames();
        if (filePaths.length === 0 && graphRenames.length === 0) return;
        this.isSyncingKnowledgeBase = true;
        const operation = this.startKnowledgeIndexOperation("syncing");
        if (!operation) {
            this.isSyncingKnowledgeBase = false;
            return;
        }
        const abortSignal = operation.signal;
        this.pendingChangedKnowledgePaths.clear();
        this.clearAutoIndexTimers();
        try {
            abortSignal.throwIfAborted();
            if (!this.services.knowledgeBase.isReady()) {
                await this.rebuildKnowledgeBase(showNotice, abortSignal);
                return;
            }
            const syncResult: KnowledgeBaseSyncResult = await this.services.knowledgeBase.syncChangedFiles(filePaths, abortSignal);
            // 增量文本同步同样先原子激活并持久化 Core；后续派生索引失败不能撤回 keyword 检索。
            this.markActiveVectorIndexStale();
            this.vectorIndexDirty = this.settings.enableVectorRetrieval;
            this.services.knowledgeGraphService.markDirty();
            this.services.masteryService.markDirty("文本索引已更新，需要重新计算掌握度。");
            this.knowledgeBaseDirty = false;
            this.coreRefreshRequiresFresh = false;
            this.setSourceInventoryStatus("ready", null);
            await this.persistKnowledgeBaseSnapshot();
            abortSignal.throwIfAborted();
            const vectorJob = await this.enqueueVectorBuild();
            this.trackBackgroundTask(this.finishIncrementalDerivedIndexes(vectorJob, syncResult, graphRenames));
            this.lastAutoIndexAt = Date.now();
            await this.persistKnowledgeBaseSnapshot();
            await this.persistRuntimeState();
            if (showNotice) this.notice("notice.index.incrementalComplete", { count: syncResult.affectedFiles.length });
        } catch (error: unknown) {
            for (const path of filePaths) this.pendingChangedKnowledgePaths.add(path);
            if (isAbortError(error)) {
                console.warn("[VaultCoachRuntime] 自动增量同步已停止。", error);
                this.knowledgeBaseDirty = true;
                this.vectorIndexDirty = this.settings.enableVectorRetrieval;
                if (showNotice) this.notice("notice.index.stopped");
                return;
            }
            console.error("[VaultCoachRuntime] 自动增量同步失败", error);
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = this.settings.enableVectorRetrieval;
        } finally {
            this.isSyncingKnowledgeBase = false;
            this.finishKnowledgeIndexOperation(operation);
        }
    }

    private async enqueueVectorBuild(): Promise<VectorBuildJob> {
        const sourceCoreGenerationId = this.getActiveCoreGenerationId();
        if (!sourceCoreGenerationId) throw new Error("Cannot queue vector build without an active Core generation.");
        return await this.services.vectorBuildCoordinator.enqueue(sourceCoreGenerationId);
    }

    private trackBackgroundTask(task: Promise<void>): void {
        const tracked = task.catch((error: unknown) => {
            console.error("[VaultCoachRuntime] 后台派生索引任务失败，CoreIndex 仍保持可用。", error);
        }).finally(() => this.backgroundDerivedTasks.delete(tracked));
        this.backgroundDerivedTasks.add(tracked);
    }

    private async finishFullDerivedIndexes(job: VectorBuildJob, sourceWasOutOfSync: boolean): Promise<void> {
        const terminal = await this.services.vectorBuildCoordinator.waitFor(job.jobId);
        if (this.disposing || this.getActiveCoreGenerationId() !== terminal.sourceCoreGenerationId) return;
        this.applyVectorJobTerminal(terminal);
        let graphRebuilt = false;
        try {
            await this.services.knowledgeGraphService.rebuildAll();
            if (this.getActiveCoreGenerationId() !== terminal.sourceCoreGenerationId) return;
            this.services.learningGraphQueryService.invalidate();
            this.services.masteryService.markDirty("确定性知识图谱已重建，需要重新计算掌握度。");
            graphRebuilt = true;
        } catch (error: unknown) {
            if (isAbortError(error)) return;
            this.services.masteryService.markDirty("知识图谱重建失败，需要重新计算掌握度。");
            console.error("[VaultCoachRuntime] 图谱构建失败，文本索引将保持可用。", error);
        }
        if (graphRebuilt && sourceWasOutOfSync) {
            await this.services.semanticGraphService.reconcileWithCurrentSources();
            await this.services.masteryService.clear();
            this.services.learningGraphQueryService.invalidate();
        }
        await this.persistKnowledgeBaseSnapshot(graphRebuilt);
    }

    private async finishIncrementalDerivedIndexes(
        job: VectorBuildJob,
        syncResult: KnowledgeBaseSyncResult,
        graphRenames: readonly GraphRename[],
    ): Promise<void> {
        const terminal = await this.services.vectorBuildCoordinator.waitFor(job.jobId);
        if (this.disposing || this.getActiveCoreGenerationId() !== terminal.sourceCoreGenerationId) return;
        this.applyVectorJobTerminal(terminal);
        try {
            await this.services.knowledgeGraphService.syncChangedFiles(syncResult, graphRenames);
            if (this.getActiveCoreGenerationId() !== terminal.sourceCoreGenerationId) return;
            this.services.learningGraphQueryService.invalidate();
            this.services.masteryService.markDirty("确定性知识图谱已增量同步，需要重新计算掌握度。");
            this.removeProcessedGraphRenames(graphRenames);
        } catch (error: unknown) {
            if (isAbortError(error)) return;
            console.error("[VaultCoachRuntime] 自动图谱增量同步失败，文本索引将保持可用。", error);
            this.services.knowledgeGraphService.markDirty();
            this.services.masteryService.markDirty("知识图谱增量同步失败，需要重新计算掌握度。");
            for (const path of syncResult.affectedFiles) this.pendingChangedKnowledgePaths.add(path);
        }
        try {
            await this.services.semanticGraphService.syncChangedFiles(syncResult);
            this.services.learningGraphQueryService.invalidate();
            this.services.masteryService.markDirty("有效概念图谱已增量同步，需要重新计算掌握度。");
        } catch (error: unknown) {
            if (isAbortError(error)) return;
            this.services.masteryService.markDirty("语义图谱增量同步失败，需要重新计算掌握度。");
            console.error("[VaultCoachRuntime] 自动语义图谱增量同步失败，文本索引将保持可用。", error);
        }
        await this.persistKnowledgeBaseSnapshot();
    }

    private applyVectorJobTerminal(job: VectorBuildJob): void {
        const ready = job.phase === "rag-ready";
        this.vectorIndexDirty = this.settings.enableVectorRetrieval && !ready;
        if (ready) {
            this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
            return;
        }
        this.markActiveVectorIndexStale();
        if (job.phase === "failed") {
            console.error("[VaultCoachRuntime] 后台向量索引建立失败，将继续使用关键词检索。", job.errorCode);
        }
    }

    private getActiveCoreGenerationId(): string | null {
        if (!this.services.knowledgeBase.isReady()) return null;
        return createCoreGenerationId(
            this.services.knowledgeBase.getSettingsSignature(),
            this.services.knowledgeBase.getSourceInventory(),
        );
    }

    private async restorePersistentState(): Promise<void> {
        const state: PersistedPluginState | null = await this.services.persistentStore.loadRuntimeState();
        if (!state) return;
        this.services.chatService.hydrate(state.messages ?? []);
        this.services.memoryService.hydrate(state.memories ?? []);
        this.lastAutoIndexAt = state.lastAutoIndexAt ?? null;
        const restoredGreeting = this.refreshRestoredDefaultGreeting();
        this.services.memoryService.trim();
        if (restoredGreeting) await this.persistRuntimeState();
    }

    private refreshRestoredDefaultGreeting(): boolean {
        const messages = this.services.chatService.getMessages();
        const firstMessage = messages[0];
        if (!firstMessage || firstMessage.role !== "assistant" || !isBuiltInDefaultGreeting(firstMessage.text)) return false;
        const effectiveGreeting = this.getEffectiveDefaultGreeting();
        if (firstMessage.text === effectiveGreeting) return false;
        messages[0] = { ...firstMessage, text: effectiveGreeting };
        this.services.chatService.hydrate(messages);
        return true;
    }

    private async restoreKnowledgeBaseSnapshot(): Promise<boolean> {
        const snapshot: KnowledgeBaseSnapshot | null = await this.services.persistentStore.loadKnowledgeBaseSnapshot();
        if (!snapshot) {
            this.setSourceInventoryStatus("not-indexed", null);
            return false;
        }
        const currentInventory = this.services.knowledgeBase.getSourceInventory();
        if (snapshot.settingsSignature !== this.services.knowledgeBase.getSettingsSignature()) {
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
            const inventoryState = getSourceInventoryStatus(snapshot.sourceInventory, currentInventory);
            this.setSourceInventoryStatus(
                inventoryState.status === "possible-domain-switch" ? "possible-domain-switch" : "source-sync-required",
                inventoryState.diff,
            );
            return false;
        }
        const inventoryState = getSourceInventoryStatus(snapshot.sourceInventory, currentInventory);
        if (inventoryState.status !== "ready") {
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = this.settings.enableVectorRetrieval;
            this.setSourceInventoryStatus(inventoryState.status, inventoryState.diff);
            return false;
        }
        this.services.knowledgeBase.loadFromSnapshot(snapshot);
        this.knowledgeBaseDirty = false;
        const vectorStats = await this.services.ragEngine.refreshVectorStatsFromStore();
        this.vectorIndexDirty = this.settings.enableVectorRetrieval && !vectorStats.ready;
        this.setSourceInventoryStatus("ready", null);
        return true;
    }

    private showOllamaEmbeddingCpuFallbackNoticeIfNeeded(): void {
        if (this.hasShownOllamaEmbeddingCpuFallbackNotice || !this.services.ragEngine.consumeOllamaEmbeddingCpuFallbackUsed()) return;
        this.hasShownOllamaEmbeddingCpuFallbackNotice = true;
        this.host.showNotice(this.t("notice.index.ollamaEmbeddingCpuFallback"), 14000);
    }

    private async persistRuntimeState(): Promise<void> {
        await this.services.persistentStore.saveRuntimeState({
            messages: this.services.chatService.getMessages(),
            memories: this.services.memoryService.getAll(),
            lastAutoIndexAt: this.lastAutoIndexAt,
        });
    }

    /** 保留最后一个完整 generation 供恢复诊断，但阻止当前配置继续查询它。 */
    private markActiveVectorIndexStale(): void {
        const current = this.services.ragEngine.getVectorIndexStats();
        this.services.ragEngine.hydrateVectorStats({
            ...current,
            ready: false,
            compatibility: current.vectorCount > 0 ? "stale" : "absent",
        });
    }

    private async persistKnowledgeBaseSnapshot(includeSourceInventory: boolean = true): Promise<void> {
        await this.services.persistentStore.saveKnowledgeBaseSnapshot({
            version: 4,
            settingsSignature: this.services.knowledgeBase.getSettingsSignature(),
            stats: this.services.knowledgeBase.getStats(),
            vectorStats: this.services.ragEngine.getVectorIndexStats(),
            chunks: this.services.knowledgeBase.getAllChunks(),
            files: this.services.knowledgeBase.getFileRecords(),
            ...(includeSourceInventory ? { sourceInventory: this.services.knowledgeBase.getSourceInventory() } : {}),
        });
    }

    private setSourceInventoryStatus(status: SourceInventoryStatus, diff: SourceInventoryDiff | null): void {
        this.sourceInventoryStatus = status;
        this.sourceInventoryDiff = diff ? {
            addedPaths: [...diff.addedPaths],
            removedPaths: [...diff.removedPaths],
            modifiedPaths: [...diff.modifiedPaths],
            unchangedCount: diff.unchangedCount,
            changedRatio: diff.changedRatio,
            isPossibleDomainSwitch: diff.isPossibleDomainSwitch,
        } : null;
    }

    private cloneSourceInventoryDiff(): SourceInventoryDiff | null {
        const diff = this.sourceInventoryDiff;
        return diff ? {
            addedPaths: [...diff.addedPaths],
            removedPaths: [...diff.removedPaths],
            modifiedPaths: [...diff.modifiedPaths],
            unchangedCount: diff.unchangedCount,
            changedRatio: diff.changedRatio,
            isPossibleDomainSwitch: diff.isPossibleDomainSwitch,
        } : null;
    }

    private clearAutoIndexTimers(): void {
        if (this.autoIndexDebounceTimer !== null) {
            window.clearTimeout(this.autoIndexDebounceTimer);
            this.autoIndexDebounceTimer = null;
        }
        if (this.autoIndexMaxWaitTimer !== null) {
            window.clearTimeout(this.autoIndexMaxWaitTimer);
            this.autoIndexMaxWaitTimer = null;
        }
    }

    private queueGraphRename(oldPath: string, newPath: string): void {
        const normalizedOldPath = normalizePath(oldPath);
        const normalizedNewPath = normalizePath(newPath);
        if (normalizedOldPath.length === 0 || normalizedNewPath.length === 0 || normalizedOldPath === normalizedNewPath) return;

        let originalPath = normalizedOldPath;
        for (const [pendingOldPath, pendingNewPath] of this.pendingGraphRenames) {
            if (pendingNewPath !== normalizedOldPath) continue;
            originalPath = pendingOldPath;
            this.pendingGraphRenames.delete(pendingOldPath);
            break;
        }
        this.pendingGraphRenames.set(originalPath, normalizedNewPath);
    }

    private getPendingGraphRenames(): GraphRename[] {
        return Array.from(this.pendingGraphRenames.entries())
            .map(([oldPath, newPath]) => ({ oldPath, newPath }))
            .sort((left, right) => left.oldPath.localeCompare(right.oldPath));
    }

    private removeProcessedGraphRenames(renames: readonly GraphRename[]): void {
        for (const rename of renames) {
            if (this.pendingGraphRenames.get(rename.oldPath) === rename.newPath) {
                this.pendingGraphRenames.delete(rename.oldPath);
            }
        }
    }

    private normalizeExamFolderPaths(folderPaths: string[]): string[] {
        return Array.from(new Set(folderPaths
            .map((path) => normalizePath(path.trim()).replace(/\/$/, ""))
            .filter((path) => path.length > 0 && !this.isVaultCoachHiddenPath(path))));
    }

    private normalizeExamScopeSelection(selection: ExamScopeSelection): ExamScopeSelection {
        return {
            selectedFolderPaths: this.normalizeExamFolderPaths(selection.selectedFolderPaths),
            excludedFilePaths: this.normalizeExamFilePaths(selection.excludedFilePaths),
            forceIncludedFilePaths: this.normalizeExamFilePaths(selection.forceIncludedFilePaths),
        };
    }

    private normalizeExamFilePaths(filePaths: string[]): string[] {
        return Array.from(new Set(filePaths
            .map((path) => normalizePath(path.trim()))
            .filter((path) => path.length > 0 && !this.isVaultCoachHiddenPath(path))));
    }

    private isKnowledgePath(path: string): boolean {
        const lowerPath = path.toLowerCase();
        return (this.settings.enableMarkdownIndexing && lowerPath.endsWith(".md"))
            || (this.settings.enablePdfIndexing && lowerPath.endsWith(".pdf"));
    }

    private isVaultCoachHiddenPath(path: string): boolean {
        return isVaultCoachHiddenPath(path);
    }
}

function createCoreReadinessTask(): CoreReadinessTask {
    let resolvePromise: () => void = () => undefined;
    let rejectPromise: (reason: unknown) => void = () => undefined;
    const task: CoreReadinessTask = {
        promise: new Promise<void>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        }),
        resolve: () => undefined,
        reject: () => undefined,
        settled: false,
    };
    task.resolve = () => {
        if (task.settled) return;
        task.settled = true;
        resolvePromise();
    };
    task.reject = (reason: unknown) => {
        if (task.settled) return;
        task.settled = true;
        rejectPromise(reason);
    };
    // 手动重建调用者可能只等待完整流程；在这种情况下避免 readiness rejection 成为未处理 rejection。
    void task.promise.catch(() => undefined);
    return task;
}

function isTerminalVectorJob(job: VectorBuildJob): boolean {
    return job.phase === "rag-ready" || job.phase === "stale" || job.phase === "failed"
        || job.phase === "cancelled" || job.phase === "superseded";
}

function normalizeKnowledgeScopeSelection(selection: KnowledgeScopeSelection): KnowledgeScopeSelection {
    if (selection.kind === "whole-vault") return selection;
    const path = normalizeVaultPath(selection.path);
    if (path.length === 0 || isVaultCoachHiddenPath(path)) {
        throw new Error("请选择有效的 Vault 目录。");
    }
    return { kind: "folder", path };
}

function getEffectiveKnowledgeScopeSignature(mode: VaultCoachSettings["knowledgeScopeMode"], folder: string): string {
    return mode === "wholeVault" ? "whole-vault" : `folder:${normalizeVaultPath(folder)}`;
}
