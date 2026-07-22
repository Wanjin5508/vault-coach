import { normalizePath, type App } from "obsidian";
import { VAULT_COACH_HIDDEN_DIR_PATH } from "../constants";
import { createApplicationContainer, type ApplicationContainer } from "./application-container";
import { getDefaultGreeting, isBuiltInDefaultGreeting, type TranslationKey } from "../i18n";
import { getErrorMessage, isAbortError } from "../utils/errors";
import type { KnowledgeBaseStats, KnowledgeBaseSyncResult } from "../domain/documents/document-types";
import type { PersistedPluginState, KnowledgeBaseSnapshot } from "../infrastructure/storage/storage-types";
import type { KnowledgeIndexBusyPhase, KnowledgeIndexBusyState } from "./index/index-types";
import type { RetrievalMode, VectorIndexStats } from "../domain/retrieval/retrieval-types";
import type { VaultCoachSettings } from "./config/settings-types";
import type { ExamScopeSelection } from "../domain/exam/exam-types";
import type { GraphRename } from "../domain/graph/graph-types";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

export interface VaultCoachRuntimeHost {
    app: App;
    pluginId: string;
    getSettings(): VaultCoachSettings;
    onStateChanged(): void;
    showNotice(message: string, timeout?: number): void;
    translate: TranslateFn;
}

interface IndexOperation {
    signal: AbortSignal;
    ownsController: boolean;
}

/**
 * Owns the application services and all non-UI runtime state.
 *
 * This class deliberately does not know about WorkspaceLeaf, ItemView, plugin
 * registration, or Settings UI. The plugin lifecycle forwards vault events and
 * supplies the small Obsidian notification/refresh adapters through its host.
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
                busy: this.getKnowledgeIndexBusyState(),
                stats: this.getKnowledgeBaseStats(),
                vectorStats: this.getVectorIndexStats(),
            }),
            rebuildIndex: (signal) => this.rebuildKnowledgeBase(false, signal),
            clearIndex: () => this.clearKnowledgeIndex(false),
            abortIndex: () => this.abortKnowledgeIndexBuild(false),
        });
        this.unsubscribeApplicationEvents = this.applicationContainer.application.subscribe(() => this.host.onStateChanged());

        await this.restorePersistentState();
        await this.restoreKnowledgeBaseSnapshot();
        await this.services.knowledgeGraphService.load();
        await this.services.semanticGraphService.load();
        if (this.services.knowledgeBase.isReady() && !this.services.knowledgeGraphService.getState().hasSnapshot) {
            this.services.knowledgeGraphService.markDirty();
        }
        if (this.services.chatService.getMessages().length === 0) {
            this.applicationContainer.application.chat.resetConversation();
        }
    }

    async dispose(): Promise<void> {
        this.abortKnowledgeIndexBuild(false);
        this.clearAutoIndexTimers();
        this.unsubscribeApplicationEvents?.();
        this.unsubscribeApplicationEvents = null;
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

    markKnowledgeBaseDirty(): void {
        this.knowledgeBaseDirty = true;
        this.vectorIndexDirty = true;
        this.services.knowledgeGraphService.markDirty();
    }

    markVectorIndexDirty(): void {
        void this.services.vectorStore.clear();
        this.services.ragEngine.hydrateVectorStats({ ready: false, vectorCount: 0, dimension: null, lastBuiltAt: null });
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

    getRuntimeRetrievalMode(): RetrievalMode {
        return this.services.chatService.getRuntimeRetrievalMode();
    }

    setRuntimeRetrievalMode(mode: RetrievalMode): void {
        this.services.chatService.setRuntimeRetrievalMode(mode);
        this.host.onStateChanged();
    }

    getActiveChatModelName(): string {
        return this.settings.modelProvider === "openai-compatible"
            ? this.settings.cloudChatModel.trim()
            : this.settings.chatModel.trim();
    }

    getActiveEmbeddingModelName(): string {
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
            if (showNotice) this.notice("notice.index.alreadyBuilding");
            return;
        }
        const abortSignal = operation.signal;
        try {
            abortSignal.throwIfAborted();
            const textSyncResult: KnowledgeBaseSyncResult = await this.services.knowledgeBase.rebuildIndexDetailed(abortSignal);
            const textStats = textSyncResult.stats;
            let vectorStats = this.services.ragEngine.getVectorIndexStats();
            let vectorBuildWarning = "";
            try {
                this.setKnowledgeIndexBusy("vector");
                abortSignal.throwIfAborted();
                vectorStats = await this.services.ragEngine.rebuildVectorIndex(abortSignal);
                this.vectorIndexDirty = false;
                this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
            } catch (error: unknown) {
                if (isAbortError(error)) throw error;
                console.error("[VaultCoachRuntime] 向量索引建立失败，将回退到关键词检索。", error);
                vectorBuildWarning = this.getVectorIndexFailureNotice(error);
                this.vectorIndexDirty = true;
            }
            try {
                await this.services.knowledgeGraphService.rebuildAll(abortSignal);
                this.services.learningGraphQueryService.invalidate();
            } catch (error: unknown) {
                if (isAbortError(error)) throw error;
                console.error("[VaultCoachRuntime] 图谱构建失败，文本索引将保持可用。", error);
            }
            this.knowledgeBaseDirty = false;
            await this.persistKnowledgeBaseSnapshot();
            if (showNotice) {
                const vectorInfo = this.settings.enableVectorRetrieval
                    ? this.t("notice.index.vectorInfo", { vectorCount: vectorStats.vectorCount })
                    : "";
                const message = this.t("notice.index.complete", {
                    fileCount: textStats.fileCount,
                    chunkCount: textStats.chunkCount,
                    vectorInfo,
                });
                this.host.showNotice(vectorBuildWarning.length > 0 ? `${message} ${vectorBuildWarning}` : message);
            }
        } catch (error: unknown) {
            if (isAbortError(error)) {
                console.warn("[VaultCoachRuntime] 索引构建已停止。", error);
                this.services.knowledgeBase.clearIndexData();
                await this.services.vectorStore.clear();
                this.services.ragEngine.hydrateVectorStats({ ready: false, vectorCount: 0, dimension: null, lastBuiltAt: null });
                this.knowledgeBaseDirty = true;
                this.vectorIndexDirty = this.settings.enableVectorRetrieval;
                if (showNotice) this.notice("notice.index.stopped");
                return;
            }
            console.error("[VaultCoachRuntime] 重建索引失败", error);
            if (showNotice) this.notice("notice.index.rebuildFailed");
        } finally {
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
        this.services.knowledgeBase.clearIndexData();
        await this.services.vectorStore.clear();
        await this.services.persistentStore.removeKnowledgeBaseSnapshot();
        try {
            await this.services.knowledgeGraphService.clear();
            this.services.learningGraphQueryService.invalidate();
        } catch (error: unknown) {
            this.services.knowledgeGraphService.markDirty();
            console.error("[VaultCoachRuntime] 清除图谱快照失败，文本索引已清除。", error);
        }
        try {
            await this.services.semanticGraphService.clear();
            this.services.learningGraphQueryService.invalidate();
        } catch (error: unknown) {
            console.error("[VaultCoachRuntime] 清除语义图谱失败，文本索引已清除。", error);
        }
        this.services.ragEngine.hydrateVectorStats({ ready: false, vectorCount: 0, dimension: null, lastBuiltAt: null });
        this.knowledgeBaseDirty = false;
        this.vectorIndexDirty = false;
        this.lastAutoIndexAt = null;
        if (showNotice) this.notice("notice.index.cleared");
    }

    abortKnowledgeIndexBuild(showNotice: boolean): void {
        const controller = this.services.indexCoordinator.getActiveAbortController();
        if (!controller || controller.signal.aborted) {
            if (showNotice) this.notice("notice.index.noActiveBuild");
            return;
        }
        controller.abort(new DOMException("VaultCoach index build aborted by user.", "AbortError"));
        if (showNotice) this.notice("notice.index.stopRequested");
    }

    async ensureKnowledgeBaseReady(): Promise<void> {
        if (!this.services.knowledgeBase.isReady() || this.knowledgeBaseDirty) {
            await this.rebuildKnowledgeBase(false);
            return;
        }
        if (this.vectorIndexDirty && this.settings.enableVectorRetrieval) {
            await this.rebuildVectorIndexOnly(false);
        }
    }

    handleVaultPathChanged(path: string): void {
        if (!this.isKnowledgePath(path) || this.isVaultCoachHiddenPath(path)) return;
        this.pendingChangedKnowledgePaths.add(path);
        this.knowledgeBaseDirty = true;
        this.vectorIndexDirty = true;
        this.services.knowledgeGraphService.markDirty();
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
            try {
                await this.services.ragEngine.syncVectorIndex(syncResult, abortSignal);
                this.vectorIndexDirty = false;
                this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
            } catch (error: unknown) {
                if (isAbortError(error)) throw error;
                console.error("[VaultCoachRuntime] 自动向量增量同步失败，将回退到关键词检索。", error);
                this.vectorIndexDirty = this.settings.enableVectorRetrieval;
            }
            try {
                await this.services.knowledgeGraphService.syncChangedFiles(
                    syncResult,
                    graphRenames,
                    abortSignal,
                );
                this.services.learningGraphQueryService.invalidate();
                this.removeProcessedGraphRenames(graphRenames);
            } catch (error: unknown) {
                if (isAbortError(error)) throw error;
                console.error("[VaultCoachRuntime] 自动图谱增量同步失败，文本索引将保持可用。", error);
                this.services.knowledgeGraphService.markDirty();
                for (const path of syncResult.affectedFiles) this.pendingChangedKnowledgePaths.add(path);
            }
            try {
                await this.services.semanticGraphService.syncChangedFiles(syncResult, abortSignal);
                this.services.learningGraphQueryService.invalidate();
            } catch (error: unknown) {
                if (isAbortError(error)) throw error;
                console.error("[VaultCoachRuntime] 自动语义图谱增量同步失败，文本索引将保持可用。", error);
            }
            this.lastAutoIndexAt = Date.now();
            this.knowledgeBaseDirty = false;
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

    private async rebuildVectorIndexOnly(showNotice: boolean, signal?: AbortSignal): Promise<void> {
        const operation = this.startKnowledgeIndexOperation("vector", signal);
        if (!operation) {
            if (showNotice) this.notice("notice.index.alreadyBuilding");
            return;
        }
        try {
            const vectorStats = await this.services.ragEngine.rebuildVectorIndex(operation.signal);
            this.vectorIndexDirty = false;
            this.knowledgeBaseDirty = false;
            this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
            await this.persistKnowledgeBaseSnapshot();
            if (showNotice) this.notice("notice.index.vectorComplete", { count: vectorStats.vectorCount });
        } catch (error: unknown) {
            if (isAbortError(error)) {
                console.warn("[VaultCoachRuntime] 向量索引构建已停止。", error);
                this.vectorIndexDirty = this.settings.enableVectorRetrieval;
                if (showNotice) this.notice("notice.index.stopped");
                return;
            }
            console.error("[VaultCoachRuntime] 向量索引重建失败", error);
            this.vectorIndexDirty = true;
            if (showNotice) this.host.showNotice(this.getVectorIndexFailureNotice(error));
        } finally {
            this.finishKnowledgeIndexOperation(operation);
        }
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

    private async restoreKnowledgeBaseSnapshot(): Promise<void> {
        const snapshot: KnowledgeBaseSnapshot | null = await this.services.persistentStore.loadKnowledgeBaseSnapshot();
        if (!snapshot) return;
        if (snapshot.settingsSignature !== this.services.knowledgeBase.getSettingsSignature()) {
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
            return;
        }
        this.services.knowledgeBase.loadFromSnapshot(snapshot);
        this.services.ragEngine.hydrateVectorStats(snapshot.vectorStats);
        this.knowledgeBaseDirty = false;
        const needsVectorStoreMigration = (snapshot.version ?? 0) < 2;
        if (needsVectorStoreMigration || snapshot.embeddingModel !== this.getEmbeddingIndexSignature()) {
            await this.services.vectorStore.clear();
            this.services.ragEngine.hydrateVectorStats({ ready: false, vectorCount: 0, dimension: null, lastBuiltAt: null });
            this.vectorIndexDirty = this.settings.enableVectorRetrieval;
            return;
        }
        this.vectorIndexDirty = false;
    }

    private showOllamaEmbeddingCpuFallbackNoticeIfNeeded(): void {
        if (this.hasShownOllamaEmbeddingCpuFallbackNotice || !this.services.ragEngine.consumeOllamaEmbeddingCpuFallbackUsed()) return;
        this.hasShownOllamaEmbeddingCpuFallbackNotice = true;
        this.host.showNotice(this.t("notice.index.ollamaEmbeddingCpuFallback"), 14000);
    }

    private getVectorIndexFailureNotice(error: unknown): string {
        return this.isLikelyLocalOllamaConnectionFailure(error)
            ? this.t("notice.index.ollamaConnectionFailed")
            : this.t("notice.index.vectorFailedWarning");
    }

    private isLikelyLocalOllamaConnectionFailure(error: unknown): boolean {
        const message = getErrorMessage(error);
        return /\/api\/(?:embed|embeddings|chat)\b/i.test(message)
            && /ERR_CONNECTION_REFUSED|ECONNREFUSED|connection refused|failed to fetch|fetch failed/i.test(message);
    }

    private async persistRuntimeState(): Promise<void> {
        await this.services.persistentStore.saveRuntimeState({
            messages: this.services.chatService.getMessages(),
            memories: this.services.memoryService.getAll(),
            lastAutoIndexAt: this.lastAutoIndexAt,
        });
    }

    private async persistKnowledgeBaseSnapshot(): Promise<void> {
        await this.services.persistentStore.saveKnowledgeBaseSnapshot({
            version: 2,
            settingsSignature: this.services.knowledgeBase.getSettingsSignature(),
            embeddingModel: this.getEmbeddingIndexSignature(),
            stats: this.services.knowledgeBase.getStats(),
            vectorStats: this.services.ragEngine.getVectorIndexStats(),
            chunks: this.services.knowledgeBase.getAllChunks(),
            files: this.services.knowledgeBase.getFileRecords(),
        });
    }

    private getEmbeddingIndexSignature(): string | null {
        if (!this.settings.enableVectorRetrieval) return null;
        if (this.settings.embeddingProvider === "openai-compatible") {
            return [
                this.settings.embeddingProvider,
                this.settings.cloudEmbeddingBaseUrl.trim().replace(/\/+$/, ""),
                this.settings.cloudEmbeddingModel.trim(),
            ].join("::");
        }
        return [
            this.settings.embeddingProvider,
            this.settings.llmBaseUrl.trim().replace(/\/+$/, ""),
            this.settings.embeddingModel.trim(),
        ].join("::");
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
        const normalizedPath = normalizePath(path);
        return normalizedPath === VAULT_COACH_HIDDEN_DIR_PATH || normalizedPath.startsWith(`${VAULT_COACH_HIDDEN_DIR_PATH}/`);
    }
}
