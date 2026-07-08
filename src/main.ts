import { Notice, normalizePath, Plugin, TAbstractFile, WorkspaceLeaf, type ListedFiles, type Stat } from "obsidian";
import { EXAM_RESULTS_DIR_PATH, VAULT_COACH_HIDDEN_DIR_PATH, VIEW_TYPE_VAULT_COACH } from "./constants";
import { getDefaultGreeting, isBuiltInDefaultGreeting, translate, type TranslationKey } from "./i18n";
import { VaultKnowledgeBase } from "./knowledge-base";
import { VaultCoachPersistentStore } from "./persistent-store";
import { AdvancedRagEngine } from "./rag-engine";
import { createDefaultSettings, DEFAULT_SETTINGS, VaultCoachSettingTab } from "./settings";
import type {
    AnswerSource,
    AssistantAnswer,
    ChatMessage,
    ExamEvaluationItem,
    ExamHistoryItem,
    ExamQuestion,
    ExamScopeOption,
    ExamSession,
    IndexedChunk,
    KnowledgeBaseSnapshot,
    KnowledgeBaseStats,
    KnowledgeBaseSyncResult,
    MemoryItem,
    MemorySearchHit,
    PersistedPluginState,
    RetrievalMode,
    StreamHandlers,
    VectorIndexStats,
    VaultCoachSettings,
} from "./types";
import { VaultCoachView } from "./view";

export default class VaultCoach extends Plugin {
    settings: VaultCoachSettings = DEFAULT_SETTINGS;

    private messages: ChatMessage[] = [];
    private memories: MemoryItem[] = [];

    private knowledgeBase!: VaultKnowledgeBase;
    private ragEngine!: AdvancedRagEngine;
    private persistentStore!: VaultCoachPersistentStore;

    private knowledgeBaseDirty = true;
    private vectorIndexDirty = true;
    private runtimeRetrievalMode: RetrievalMode = DEFAULT_SETTINGS.defaultRetrievalMode;

    // 新增：自动增量同步所需的队列与计时器。
    private readonly pendingChangedMarkdownPaths: Set<string> = new Set<string>();
    private autoIndexDebounceTimer: number | null = null;
    private autoIndexMaxWaitTimer: number | null = null;
    private isSyncingKnowledgeBase = false;
    private lastAutoIndexAt: number | null = null;
    private hasShownOllamaEmbeddingCpuFallbackNotice = false;

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    async onload(): Promise<void> {
        await this.loadSettings();

        this.runtimeRetrievalMode = this.settings.defaultRetrievalMode;
        this.knowledgeBase = new VaultKnowledgeBase(this.app, () => this.settings);
        this.ragEngine = new AdvancedRagEngine(
            this.knowledgeBase,
            () => this.settings,
            () => this.runtimeRetrievalMode,
            () => this.getCloudApiKey(),
        );
        this.persistentStore = new VaultCoachPersistentStore(this.app, this.manifest.id);

        await this.restorePersistentState();
        await this.restoreKnowledgeBaseSnapshot();

        if (this.messages.length === 0) {
            this.resetConversation();
        }

        this.registerView(
            VIEW_TYPE_VAULT_COACH,
            (leaf: WorkspaceLeaf) => new VaultCoachView(leaf, this),
        );

        this.addCommand({
            id: "open-view",
            name: this.t("command.openView"),
            callback: async () => {
                await this.activateView();
            },
        });

        this.addCommand({
            id: "reset-conversation",
            name: this.t("command.resetConversation"),
            callback: () => {
                this.resetConversation();
                this.refreshAllViews();
                new Notice(this.t("notice.resetSuccess"));
            },
        });

        this.addCommand({
            id: "rebuild-knowledge-index",
            name: this.t("command.rebuildKnowledgeIndex"),
            callback: async () => {
                await this.rebuildKnowledgeBase(true);
            },
        });

        this.addRibbonIcon("message-square", this.t("ribbon.openVaultCoach"), () => {
            void this.activateView();
        });

        this.addSettingTab(new VaultCoachSettingTab(this.app, this));
        this.registerDomEvent(window, "languagechange", () => {
            this.refreshBuiltInDefaultGreeting();
            this.refreshAllViews();
        });
        this.registerVaultEvents();

        if (!this.knowledgeBase.isReady()) {
            await this.rebuildKnowledgeBase(false);
        } else if (this.vectorIndexDirty && this.settings.enableVectorRetrieval) {
            await this.rebuildVectorIndexOnly(false);
        }

        this.app.workspace.onLayoutReady(() => {
            if (this.settings.openInRightSidebarOnStartup) {
                void this.activateView();
            }
        });
    }

    onunload(): void {
        this.clearAutoIndexTimers();
    }

    async loadSettings(): Promise<void> {
        const savedSettings: Partial<VaultCoachSettings> = ((await this.loadData()) as Partial<VaultCoachSettings> | null) ?? {};
        this.settings = Object.assign(
            {},
            createDefaultSettings(),
            savedSettings,
        );
        this.refreshBuiltInDefaultGreeting();
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    private refreshBuiltInDefaultGreeting(): void {
        if (this.settings.defaultGreeting.trim().length === 0 || isBuiltInDefaultGreeting(this.settings.defaultGreeting)) {
            this.settings.defaultGreeting = getDefaultGreeting();
        }
    }

    getCloudApiKey(): string | null {
        const secretName = this.settings.cloudApiKeySecretName.trim();
        if (secretName.length === 0) {
            return null;
        }

        return this.app.secretStorage.getSecret(secretName);
    }

    markKnowledgeBaseDirty(): void {
        // Text chunk changes invalidate both the keyword index and any vectors built from those chunks.
        // Keep this path for scan scope / chunking changes where the whole knowledge base must be rebuilt.
        this.knowledgeBaseDirty = true;
        this.vectorIndexDirty = true;
        this.refreshAllViews();
    }

    markVectorIndexDirty(): void {
        // Embedding service/model changes do not invalidate parsed Markdown chunks or the keyword index.
        // Clear stale vectors so the UI and retrieval layer never report old embeddings as current.
        this.knowledgeBase.clearVectorIndex();
        this.ragEngine.hydrateVectorStats({
            ready: false,
            vectorCount: 0,
            dimension: null,
            lastBuiltAt: null,
        });
        this.vectorIndexDirty = this.settings.enableVectorRetrieval;
        this.refreshAllViews();
    }

    isKnowledgeBaseDirty(): boolean {
        return this.isTextIndexDirty();
    }

    isTextIndexDirty(): boolean {
        return this.knowledgeBaseDirty;
    }

    isVectorIndexDirty(): boolean {
        return this.vectorIndexDirty;
    }

    getKnowledgeBaseStats(): KnowledgeBaseStats {
        return this.knowledgeBase.getStats();
    }

    getVectorIndexStats(): VectorIndexStats {
        return this.ragEngine.getVectorIndexStats();
    }

    getKnowledgeScopeDescription(): string {
        const stats: KnowledgeBaseStats = this.getKnowledgeBaseStats();
        return stats.scopeDescription;
    }

    getLocalizedKnowledgeScopeDescription(): string {
        if (this.settings.knowledgeScopeMode === "wholeVault") {
            return this.t("scope.wholeVault");
        }

        const folderPath: string = this.settings.knowledgeFolder.trim().replace(/\/$/, "");
        if (folderPath.length === 0) {
            return this.t("scope.folderUnset");
        }

        return this.t("scope.folder", { folder: folderPath });
    }

    getExamScopeOptions(): ExamScopeOption[] {
        const stats: KnowledgeBaseStats = this.knowledgeBase.getStats();
        return [
            {
                id: "__all__",
                label: this.t("exam.scope.fullCurrentKnowledgeBase"),
                folderPath: null,
                fileCount: stats.fileCount,
                chunkCount: stats.chunkCount,
            },
            ...this.knowledgeBase.getExamFolderScopeOptions(),
        ];
    }

    async createExamSession(selectedFolderPaths: string[], questionCount: number): Promise<ExamSession> {
        await this.ensureKnowledgeBaseReady();

        const normalizedFolderPaths: string[] = this.normalizeExamFolderPaths(selectedFolderPaths);
        const chunks: IndexedChunk[] = this.knowledgeBase.getChunksForExamScope(normalizedFolderPaths);
        if (chunks.length === 0) {
            throw new Error(this.t("exam.notice.noChunks"));
        }

        const scopeLabel: string = normalizedFolderPaths.length === 0
            ? this.t("exam.scope.fullCurrentKnowledgeBase")
            : normalizedFolderPaths.join(", ");

        return this.ragEngine.generateExamSession(scopeLabel, normalizedFolderPaths, chunks, questionCount);
    }

    async evaluateExamSession(session: ExamSession, userAnswers: string[]): Promise<ExamSession> {
        const evaluation = await this.ragEngine.evaluateExamSession(session, userAnswers);
        return {
            ...session,
            userAnswers: session.questions.map((_question: ExamQuestion, index: number) => userAnswers[index]?.trim() ?? ""),
            evaluation,
            status: "submitted",
        };
    }

    async saveExamSession(session: ExamSession): Promise<ExamSession> {
        await this.ensureExamResultsDirectory();

        const savedPath: string = session.savedPath ?? this.createExamResultPath(session);
        const savedSession: ExamSession = {
            ...session,
            savedPath,
            status: "saved",
        };

        await this.app.vault.adapter.write(savedPath, this.formatExamSessionMarkdown(savedSession));
        return savedSession;
    }

    async exportExamSession(session: ExamSession, targetFolderPath: string): Promise<string> {
        const normalizedFolderPath: string = await this.ensureExportFolder(targetFolderPath);
        const exportPath: string = await this.createUniqueExamResultPath(normalizedFolderPath, session);
        await this.app.vault.adapter.write(exportPath, this.formatExamSessionMarkdown(session));
        return exportPath;
    }

    async listExamHistory(): Promise<ExamHistoryItem[]> {
        await this.ensureExamResultsDirectory();

        const listedFiles: ListedFiles = await this.app.vault.adapter.list(EXAM_RESULTS_DIR_PATH);
        const markdownPaths: string[] = listedFiles.files
            .filter((path: string) => path.toLowerCase().endsWith(".md"))
            .sort((leftPath: string, rightPath: string) => rightPath.localeCompare(leftPath));

        const items: ExamHistoryItem[] = [];
        for (const path of markdownPaths) {
            try {
                const [content, stat]: [string, Stat | null] = await Promise.all([
                    this.app.vault.adapter.read(path),
                    this.app.vault.adapter.stat(path),
                ]);
                items.push(this.parseExamHistoryItem(path, content, stat));
            } catch (error: unknown) {
                console.error("[VaultCoach] 读取考试历史失败", error);
            }
        }

        items.sort((left: ExamHistoryItem, right: ExamHistoryItem) => {
            return (right.createdAt ?? right.modifiedAt ?? 0) - (left.createdAt ?? left.modifiedAt ?? 0);
        });
        return items;
    }

    async readExamHistoryContent(path: string): Promise<string> {
        const normalizedPath: string = normalizePath(path);
        if (!this.isExamResultPath(normalizedPath)) {
            throw new Error(this.t("exam.notice.invalidHistoryPath"));
        }

        return this.app.vault.adapter.read(normalizedPath);
    }

    async deleteExamSession(session: ExamSession): Promise<void> {
        if (!session.savedPath) {
            return;
        }

        const savedPath: string = normalizePath(session.savedPath);
        if (await this.app.vault.adapter.exists(savedPath)) {
            await this.app.vault.adapter.remove(savedPath);
        }
    }

    async deleteExamHistory(path: string): Promise<void> {
        const normalizedPath: string = normalizePath(path);
        if (!this.isExamResultPath(normalizedPath)) {
            throw new Error(this.t("exam.notice.invalidHistoryPath"));
        }

        if (await this.app.vault.adapter.exists(normalizedPath)) {
            await this.app.vault.adapter.remove(normalizedPath);
        }
    }

    getEffectiveDefaultGreeting(): string {
        const configuredGreeting: string = this.settings.defaultGreeting.trim();
        if (configuredGreeting.length === 0 || isBuiltInDefaultGreeting(configuredGreeting)) {
            return getDefaultGreeting();
        }

        return this.settings.defaultGreeting;
    }

    getRuntimeRetrievalMode(): RetrievalMode {
        return this.runtimeRetrievalMode;
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

    setRuntimeRetrievalMode(mode: RetrievalMode): void {
        this.runtimeRetrievalMode = mode;
        this.refreshAllViews();
    }

    getMessages(): ChatMessage[] {
        return this.messages;
    }

    // 新增：供视图头部展示当前长期记忆数量。
    getMemoryCount(): number {
        return this.memories.length;
    }

    // 新增：发送前先持久化用户消息，确保异常中断时对话不会丢。
    async appendUserMessage(text: string): Promise<void> {
        this.messages.push({
            role: "user",
            text,
            createdAt: Date.now(),
        });
        this.trimMessages();
        await this.persistRuntimeState();
    }

    addAssistantMessage(text: string, sources: AnswerSource[]): void {
        this.messages.push({
            role: "assistant",
            text,
            createdAt: Date.now(),
            sources,
        });
        this.trimMessages();
    }

    resetConversation(): void {
        this.messages = [
            {
                role: "assistant",
                text: this.getEffectiveDefaultGreeting(),
                createdAt: Date.now(),
            },
        ];
        void this.persistRuntimeState();
    }

    refreshAllViews(): void {
        const leaves: WorkspaceLeaf[] = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH);
        for (const leaf of leaves) {
            const view = leaf.view;
            if (view instanceof VaultCoachView) {
                view.refresh();
            }
        }
    }

    async rebuildKnowledgeBase(showNotice: boolean): Promise<void> {
        try {
            const textSyncResult: KnowledgeBaseSyncResult = await this.knowledgeBase.rebuildIndexDetailed();
            const textStats: KnowledgeBaseStats = textSyncResult.stats;

            let vectorStats: VectorIndexStats = this.ragEngine.getVectorIndexStats();
            let vectorBuildWarning = "";

            try {
                vectorStats = await this.ragEngine.rebuildVectorIndex();
                this.vectorIndexDirty = false;
                this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
            } catch (vectorError: unknown) {
                console.error("[VaultCoach] 向量索引建立失败，将回退到关键词检索。", vectorError);
                vectorBuildWarning = this.t("notice.index.vectorFailedWarning");
                this.vectorIndexDirty = true;
            }

            this.knowledgeBaseDirty = false;
            await this.persistKnowledgeBaseSnapshot();
            this.refreshAllViews();

            if (showNotice) {
                const vectorInfo: string = this.settings.enableVectorRetrieval
                    ? this.t("notice.index.vectorInfo", { vectorCount: vectorStats.vectorCount })
                    : "";
                const message: string = this.t("notice.index.complete", {
                    fileCount: textStats.fileCount,
                    chunkCount: textStats.chunkCount,
                    vectorInfo,
                });
                new Notice(vectorBuildWarning.length > 0 ? `${message} ${vectorBuildWarning}` : message);
            }
        } catch (error: unknown) {
            console.error("[VaultCoach] 重建索引失败", error);
            if (showNotice) {
                new Notice(this.t("notice.index.rebuildFailed"));
            }
        }
    }

    async ensureKnowledgeBaseReady(): Promise<void> {
        if (!this.knowledgeBase.isReady() || this.knowledgeBaseDirty) {
            await this.rebuildKnowledgeBase(false);
            return;
        }

        if (this.vectorIndexDirty && this.settings.enableVectorRetrieval) {
            await this.rebuildVectorIndexOnly(false);
        }
    }

    async activateView(): Promise<void> {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH)[0] ?? null;

        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            if (!leaf) {
                new Notice(this.t("notice.cannotCreateView"));
                return;
            }

            await leaf.setViewState({
                type: VIEW_TYPE_VAULT_COACH,
                active: true,
            });
        }

        workspace.setActiveLeaf(leaf, { focus: true });
    }

    // 新增：视图发送消息时调用，内部负责流式生成、记忆更新与持久化。
    async streamAssistantTurn(userText: string, handlers?: StreamHandlers): Promise<AssistantAnswer> {
        await this.ensureKnowledgeBaseReady();

        const memoryContext: string = this.buildMemoryContext(userText);
        try {
            const answer: AssistantAnswer = await this.ragEngine.streamAnswerQuestion(
                userText,
                this.messages,
                this.getKnowledgeScopeDescription(),
                memoryContext,
                handlers,
            );

            this.addAssistantMessage(answer.text, answer.sources);
            if (!handlers?.abortSignal?.aborted) {
                await this.updateLongTermMemory(userText, answer.text);
            }
            await this.persistRuntimeState();

            return answer;
        } finally {
            this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
        }
    }

    async openSource(source: AnswerSource): Promise<void> {
        const activeFilePath: string = this.app.workspace.getActiveFile()?.path ?? "";
        const linkTarget: string = source.heading
            ? `${source.filePath}#${source.heading}`
            : source.filePath;

        await this.app.workspace.openLinkText(linkTarget, activeFilePath, false);
    }

    private registerVaultEvents(): void {
        const queuePath = (path: string): void => {
            if (!this.isMarkdownPath(path) || this.isVaultCoachHiddenPath(path)) {
                return;
            }

            this.pendingChangedMarkdownPaths.add(path);
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
            this.refreshAllViews();
            this.scheduleAutoIndexSync();
        };

        this.registerEvent(this.app.vault.on("create", (file: TAbstractFile) => {
            queuePath(file.path);
        }));

        this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {
            queuePath(file.path);
        }));

        this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
            queuePath(file.path);
        }));

        this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
            queuePath(oldPath);
            queuePath(file.path);
        }));
    }

    // 新增：当累计变更达到阈值或等待时间到达上限时自动触发增量同步。
    private scheduleAutoIndexSync(): void {
        if (!this.settings.enableAutoIndexSync) {
            return;
        }

        if (this.pendingChangedMarkdownPaths.size >= this.settings.autoIndexFileThreshold) {
            void this.flushPendingKnowledgeBaseSync(false);
            return;
        }

        if (this.autoIndexDebounceTimer !== null) {
            window.clearTimeout(this.autoIndexDebounceTimer);
        }

        this.autoIndexDebounceTimer = window.setTimeout(() => {
            void this.flushPendingKnowledgeBaseSync(false);
        }, this.settings.autoIndexDebounceMs);

        if (this.autoIndexMaxWaitTimer === null) {
            this.autoIndexMaxWaitTimer = window.setTimeout(() => {
                void this.flushPendingKnowledgeBaseSync(false);
            }, this.settings.autoIndexMaxWaitMs);
        }
    }

    // 新增：对 pending 文件执行真正的增量同步，并只重算变更 chunk 的 embedding。
    private async flushPendingKnowledgeBaseSync(showNotice: boolean): Promise<void> {
        if (this.isSyncingKnowledgeBase) {
            return;
        }

        const filePaths: string[] = Array.from(this.pendingChangedMarkdownPaths);
        if (filePaths.length === 0) {
            return;
        }

        this.isSyncingKnowledgeBase = true;
        this.pendingChangedMarkdownPaths.clear();
        this.clearAutoIndexTimers();

        try {
            if (!this.knowledgeBase.isReady()) {
                await this.rebuildKnowledgeBase(showNotice);
                return;
            }

            const syncResult: KnowledgeBaseSyncResult = await this.knowledgeBase.syncChangedFiles(filePaths);
            await this.ragEngine.syncVectorIndex(syncResult);
            this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();

            this.lastAutoIndexAt = Date.now();
            this.knowledgeBaseDirty = false;
            this.vectorIndexDirty = false;

            await this.persistKnowledgeBaseSnapshot();
            await this.persistRuntimeState();
            this.refreshAllViews();

            if (showNotice) {
                new Notice(this.t("notice.index.incrementalComplete", { count: syncResult.affectedFiles.length }));
            }
        } catch (error: unknown) {
            console.error("[VaultCoach] 自动增量同步失败", error);
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
        } finally {
            this.isSyncingKnowledgeBase = false;
        }
    }

    private async rebuildVectorIndexOnly(showNotice: boolean): Promise<void> {
        try {
            const vectorStats: VectorIndexStats = await this.ragEngine.rebuildVectorIndex();
            this.vectorIndexDirty = false;
            this.knowledgeBaseDirty = false;
            this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
            await this.persistKnowledgeBaseSnapshot();
            this.refreshAllViews();

            if (showNotice) {
                new Notice(this.t("notice.index.vectorComplete", { count: vectorStats.vectorCount }));
            }
        } catch (error: unknown) {
            console.error("[VaultCoach] 向量索引重建失败", error);
            this.vectorIndexDirty = true;
            if (showNotice) {
                new Notice(this.t("notice.index.vectorRebuildFailed"));
            }
        }
    }

    private async restorePersistentState(): Promise<void> {
        const state: PersistedPluginState | null = await this.persistentStore.loadRuntimeState();
        if (!state) {
            return;
        }

        this.messages = state.messages ?? [];
        this.memories = state.memories ?? [];
        this.lastAutoIndexAt = state.lastAutoIndexAt ?? null;
        this.trimMessages();
        this.trimMemories();
    }

    private async restoreKnowledgeBaseSnapshot(): Promise<void> {
        const snapshot: KnowledgeBaseSnapshot | null = await this.persistentStore.loadKnowledgeBaseSnapshot();
        if (!snapshot) {
            return;
        }

        const textSignatureMatches: boolean = snapshot.settingsSignature === this.knowledgeBase.getSettingsSignature();
        if (!textSignatureMatches) {
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
            return;
        }

        this.knowledgeBase.loadFromSnapshot(snapshot);
        this.ragEngine.hydrateVectorStats(snapshot.vectorStats);
        this.knowledgeBaseDirty = false;

        const currentEmbeddingModel: string | null = this.getEmbeddingIndexSignature();

        if (snapshot.embeddingModel !== currentEmbeddingModel) {
            this.knowledgeBase.clearVectorIndex();
            this.ragEngine.hydrateVectorStats({
                ready: false,
                vectorCount: 0,
                dimension: null,
                lastBuiltAt: null,
            });
            this.vectorIndexDirty = this.settings.enableVectorRetrieval;
        } else {
            this.vectorIndexDirty = false;
        }
    }

    private showOllamaEmbeddingCpuFallbackNoticeIfNeeded(): void {
        // CPU fallback may happen once per embedding batch. Show a single user-facing notice per plugin session.
        if (this.hasShownOllamaEmbeddingCpuFallbackNotice) {
            return;
        }

        if (!this.ragEngine.consumeOllamaEmbeddingCpuFallbackUsed()) {
            return;
        }

        this.hasShownOllamaEmbeddingCpuFallbackNotice = true;
        new Notice(this.t("notice.index.ollamaEmbeddingCpuFallback"), 14000);
    }

    private async persistRuntimeState(): Promise<void> {
        const state: PersistedPluginState = {
            messages: [...this.messages],
            memories: [...this.memories],
            lastAutoIndexAt: this.lastAutoIndexAt,
        };
        await this.persistentStore.saveRuntimeState(state);
    }

    private async persistKnowledgeBaseSnapshot(): Promise<void> {
        const snapshot: KnowledgeBaseSnapshot = {
            version: 1,
            settingsSignature: this.knowledgeBase.getSettingsSignature(),
            embeddingModel: this.getEmbeddingIndexSignature(),
            stats: this.knowledgeBase.getStats(),
            vectorStats: this.ragEngine.getVectorIndexStats(),
            chunks: this.knowledgeBase.getAllChunks(),
            embeddings: this.knowledgeBase.getEmbeddingSnapshot(),
            files: this.knowledgeBase.getFileRecords(),
        };
        await this.persistentStore.saveKnowledgeBaseSnapshot(snapshot);
    }

    private getEmbeddingIndexSignature(): string | null {
        if (!this.settings.enableVectorRetrieval) {
            return null;
        }

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

    // 新增：从本地长期记忆中检索与当前问题最相关的条目，并注入到 prompt。
    private buildMemoryContext(query: string): string {
        if (!this.settings.enableLongTermMemory || this.memories.length === 0) {
            return "";
        }

        const hits: MemorySearchHit[] = this.searchMemories(query, this.settings.memoryTopK);
        if (hits.length === 0) {
            return "";
        }

        const now: number = Date.now();
        for (const hit of hits) {
            hit.item.lastAccessedAt = now;
        }

        return hits
            .map((hit: MemorySearchHit, index: number) => `${index + 1}. ${hit.item.text}`)
            .join("\n");
    }

    // 新增：回答结束后抽取长期记忆并做本地去重、更新和裁剪。
    private async updateLongTermMemory(userText: string, assistantText: string): Promise<void> {
        if (!this.settings.enableLongTermMemory) {
            return;
        }

        const memoryStatements: string[] = await this.ragEngine.extractMemoryStatements(
            userText,
            assistantText,
            this.messages,
        );

        if (memoryStatements.length === 0) {
            return;
        }

        const now: number = Date.now();
        for (const statement of memoryStatements) {
            const normalizedStatement: string = this.normalizeMemoryText(statement);
            if (normalizedStatement.length === 0) {
                continue;
            }

            const existing: MemoryItem | undefined = this.memories.find((item: MemoryItem) => {
                return this.normalizeMemoryText(item.text) === normalizedStatement;
            });

            if (existing) {
                existing.text = statement.trim();
                existing.updatedAt = now;
                existing.lastAccessedAt = now;
                continue;
            }

            this.memories.unshift({
                id: this.createMemoryId(normalizedStatement),
                text: statement.trim(),
                createdAt: now,
                updatedAt: now,
                lastAccessedAt: now,
            });
        }

        this.trimMemories();
    }

    private searchMemories(query: string, limit: number): MemorySearchHit[] {
        const normalizedQuery: string = this.normalizeMemoryText(query);
        const queryTokens: string[] = Array.from(new Set(this.tokenize(query)));
        const hits: MemorySearchHit[] = [];

        for (const item of this.memories) {
            const normalizedText: string = this.normalizeMemoryText(item.text);
            const memoryTokens: Set<string> = new Set(this.tokenize(item.text));

            let score = 0;
            let overlapCount = 0;

            if (normalizedQuery.length > 0 && normalizedText.includes(normalizedQuery)) {
                score += 3;
            }

            for (const token of queryTokens) {
                if (memoryTokens.has(token)) {
                    overlapCount += 1;
                }
            }

            if (overlapCount === 0 && score === 0) {
                continue;
            }

            score += overlapCount * 0.6;
            score += Math.max(0, (item.updatedAt - (Date.now() - 1000 * 60 * 60 * 24 * 30)) / (1000 * 60 * 60 * 24 * 30));

            hits.push({
                item,
                score,
                matchedTokens: queryTokens.filter((token: string) => memoryTokens.has(token)),
            });
        }

        hits.sort((left: MemorySearchHit, right: MemorySearchHit) => right.score - left.score);
        return hits.slice(0, limit);
    }

    private trimMessages(): void {
        const maxMessages: number = Math.max(1, this.settings.maxConversationMessages);
        if (this.messages.length <= maxMessages) {
            return;
        }

        const greeting: ChatMessage | undefined = this.messages.find((message: ChatMessage) => message.role === "assistant");
        const tail: ChatMessage[] = this.messages.slice(-maxMessages);

        if (greeting && !tail.includes(greeting)) {
            this.messages = [greeting, ...tail.slice(1)];
            return;
        }

        this.messages = tail;
    }

    private trimMemories(): void {
        const maxItems: number = Math.max(1, this.settings.memoryMaxItems);
        if (this.memories.length <= maxItems) {
            return;
        }

        this.memories.sort((left: MemoryItem, right: MemoryItem) => {
            const rightKey: number = Math.max(right.updatedAt, right.lastAccessedAt);
            const leftKey: number = Math.max(left.updatedAt, left.lastAccessedAt);
            return rightKey - leftKey;
        });

        this.memories = this.memories.slice(0, maxItems);
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

    private normalizeMemoryText(text: string): string {
        return text.toLowerCase().replace(/\s+/g, " ").trim();
    }

    private tokenize(text: string): string[] {
        const normalizedText: string = text.toLowerCase();
        const tokens: string[] = [];

        const latinMatches: RegExpMatchArray | null = normalizedText.match(/[a-z0-9_./-]+/g);
        if (latinMatches) {
            for (const token of latinMatches) {
                if (token.trim().length > 0) {
                    tokens.push(token.trim());
                }
            }
        }

        const chineseSequences: RegExpMatchArray | null = normalizedText.match(/[\u4e00-\u9fff]+/g);
        if (chineseSequences) {
            for (const sequence of chineseSequences) {
                for (const char of sequence) {
                    tokens.push(char);
                }

                for (let index = 0; index < sequence.length - 1; index += 1) {
                    tokens.push(sequence.slice(index, index + 2));
                }
            }
        }

        return tokens;
    }

    private createMemoryId(text: string): string {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `mem_${(hash >>> 0).toString(16)}`;
    }

    private normalizeExamFolderPaths(folderPaths: string[]): string[] {
        return Array.from(new Set(
            folderPaths
                .map((folderPath: string) => normalizePath(folderPath.trim()).replace(/\/$/, ""))
                .filter((folderPath: string) => folderPath.length > 0 && !this.isVaultCoachHiddenPath(folderPath)),
        ));
    }

    private async ensureExamResultsDirectory(): Promise<void> {
        const hiddenDirPath: string = normalizePath(VAULT_COACH_HIDDEN_DIR_PATH);
        const examDirPath: string = normalizePath(EXAM_RESULTS_DIR_PATH);

        if (!(await this.app.vault.adapter.exists(hiddenDirPath))) {
            await this.app.vault.adapter.mkdir(hiddenDirPath);
        }

        if (!(await this.app.vault.adapter.exists(examDirPath))) {
            await this.app.vault.adapter.mkdir(examDirPath);
        }
    }

    private async ensureExportFolder(targetFolderPath: string): Promise<string> {
        const normalizedFolderPath: string = normalizePath(targetFolderPath.trim()).replace(/\/$/, "");
        if (normalizedFolderPath.length === 0 || normalizedFolderPath === "/") {
            return "";
        }

        await this.ensureFolderPath(normalizedFolderPath);
        return normalizedFolderPath;
    }

    private async ensureFolderPath(folderPath: string): Promise<void> {
        const parts: string[] = normalizePath(folderPath)
            .split("/")
            .map((part: string) => part.trim())
            .filter((part: string) => part.length > 0);

        let currentPath = "";
        for (const part of parts) {
            currentPath = currentPath.length === 0 ? part : `${currentPath}/${part}`;
            const stat: Stat | null = await this.app.vault.adapter.stat(currentPath);
            if (stat?.type === "file") {
                throw new Error(this.t("exam.notice.exportPathIsFile"));
            }

            if (!stat) {
                await this.app.vault.adapter.mkdir(currentPath);
            }
        }
    }

    private createExamResultPath(session: ExamSession): string {
        const safeTitle: string = this.sanitizeFileName(session.title || this.t("exam.defaultTitle"));
        return normalizePath(`${EXAM_RESULTS_DIR_PATH}/${session.id}-${safeTitle}.md`);
    }

    private async createUniqueExamResultPath(folderPath: string, session: ExamSession): Promise<string> {
        const safeTitle: string = this.sanitizeFileName(session.title || this.t("exam.defaultTitle"));
        const basePath: string = normalizePath(folderPath.length > 0
            ? `${folderPath}/${session.id}-${safeTitle}`
            : `${session.id}-${safeTitle}`);

        let candidatePath = `${basePath}.md`;
        let duplicateIndex = 2;
        while (await this.app.vault.adapter.exists(candidatePath)) {
            candidatePath = `${basePath}-${duplicateIndex}.md`;
            duplicateIndex += 1;
        }

        return candidatePath;
    }

    private sanitizeFileName(value: string): string {
        const sanitizedValue: string = value
            .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60);

        return sanitizedValue.length > 0 ? sanitizedValue : this.t("exam.defaultTitle");
    }

    private formatExamSessionMarkdown(session: ExamSession): string {
        const lines: string[] = [
            "---",
            "vaultCoachExam: true",
            `examId: ${JSON.stringify(session.id)}`,
            `createdAt: ${session.createdAt}`,
            `score: ${session.evaluation?.score ?? ""}`,
            `maxScore: ${session.evaluation?.maxScore ?? ""}`,
            `scope: ${JSON.stringify(session.scopeLabel)}`,
            "---",
            "",
            `# ${session.title}`,
            "",
            `- ${this.t("exam.markdown.id")}：${session.id}`,
            `- ${this.t("exam.markdown.createdAt")}：${this.formatDateTime(session.createdAt)}`,
            `- ${this.t("exam.markdown.scope")}：${session.scopeLabel}`,
            `- ${this.t("exam.markdown.questionCount")}：${session.questions.length}`,
        ];

        if (session.evaluation) {
            lines.push(`- ${this.t("exam.markdown.score")}：${session.evaluation.score} / ${session.evaluation.maxScore}`);
            lines.push("");
            lines.push(`## ${this.t("exam.markdown.overallFeedback")}`);
            lines.push("");
            lines.push(session.evaluation.overallFeedback);
        }

        lines.push("");
        lines.push(`## ${this.t("exam.markdown.questions")}`);

        session.questions.forEach((question: ExamQuestion, index: number) => {
            const answer: string = session.userAnswers[index]?.trim() ?? "";
            const evaluationItem: ExamEvaluationItem | undefined = session.evaluation?.items.find((item: ExamEvaluationItem) => {
                return item.questionId === question.id;
            });

            lines.push("");
            lines.push(`### ${index + 1}. ${question.question}`);
            lines.push("");
            lines.push(`#### ${this.t("exam.markdown.userAnswer")}`);
            lines.push("");
            lines.push(answer.length > 0 ? answer : this.t("exam.unanswered"));
            lines.push("");
            lines.push(`#### ${this.t("exam.markdown.referenceAnswer")}`);
            lines.push("");
            lines.push(question.referenceAnswer);
            lines.push("");
            lines.push(`#### ${this.t("exam.markdown.rubric")}`);
            lines.push("");
            lines.push(question.rubric);

            if (evaluationItem) {
                lines.push("");
                lines.push(`#### ${this.t("exam.markdown.evaluation")}`);
                lines.push("");
                lines.push(`- ${this.t("exam.markdown.score")}：${evaluationItem.score} / ${evaluationItem.maxScore}`);
                lines.push(`- ${this.t("exam.markdown.feedback")}：${evaluationItem.feedback}`);
                lines.push(`- ${this.t("exam.markdown.improvement")}：${evaluationItem.improvement}`);
            }

            if (question.sourcePaths.length > 0) {
                lines.push("");
                lines.push(`#### ${this.t("exam.markdown.sources")}`);
                lines.push("");
                for (const sourcePath of question.sourcePaths) {
                    lines.push(`- [[${sourcePath}]]`);
                }
            }
        });

        lines.push("");
        return lines.join("\n");
    }

    private formatDateTime(timestamp: number): string {
        return new Date(timestamp).toLocaleString();
    }

    private parseExamHistoryItem(path: string, content: string, stat: Stat | null): ExamHistoryItem {
        const title: string = this.parseFirstMarkdownHeading(content) || this.sanitizeHistoryTitle(path);
        const createdAt: number | null = this.parseNumberMetadata(content, "createdAt")
            ?? this.parseCreatedAtFromMarkdown(content);
        const score: number | null = this.parseNumberMetadata(content, "score")
            ?? this.parseScoreFromMarkdown(content, 0);
        const maxScore: number | null = this.parseNumberMetadata(content, "maxScore")
            ?? this.parseScoreFromMarkdown(content, 1);

        return {
            path,
            title,
            createdAt,
            score,
            maxScore,
            modifiedAt: stat?.mtime ?? null,
        };
    }

    private parseFirstMarkdownHeading(content: string): string | null {
        const match: RegExpExecArray | null = /^#\s+(.+)$/m.exec(content);
        return match?.[1]?.trim() ?? null;
    }

    private sanitizeHistoryTitle(path: string): string {
        const fileName: string = path.split("/").pop() ?? this.t("exam.defaultTitle");
        return fileName.replace(/\.md$/i, "");
    }

    private parseNumberMetadata(content: string, key: string): number | null {
        const match: RegExpExecArray | null = new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m").exec(content);
        if (!match?.[1]) {
            return null;
        }

        const parsedValue: number = Number.parseInt(match[1], 10);
        return Number.isFinite(parsedValue) ? parsedValue : null;
    }

    private parseCreatedAtFromMarkdown(content: string): number | null {
        const match: RegExpExecArray | null = /创建时间[：:]\s*(.+)$/m.exec(content)
            ?? /Created at[：:]\s*(.+)$/m.exec(content);
        const rawDate: string | undefined = match?.[1]?.trim();
        if (!rawDate) {
            return null;
        }

        const timestamp: number = Date.parse(rawDate);
        return Number.isFinite(timestamp) ? timestamp : null;
    }

    private parseScoreFromMarkdown(content: string, index: 0 | 1): number | null {
        const match: RegExpExecArray | null = /(?:得分|Score)[：:]\s*(\d+)\s*\/\s*(\d+)/m.exec(content);
        const rawValue: string | undefined = match?.[index + 1];
        if (!rawValue) {
            return null;
        }

        const parsedValue: number = Number.parseInt(rawValue, 10);
        return Number.isFinite(parsedValue) ? parsedValue : null;
    }

    private isMarkdownPath(path: string): boolean {
        return path.toLowerCase().endsWith(".md");
    }

    private isExamResultPath(path: string): boolean {
        const normalizedPath: string = normalizePath(path);
        return normalizedPath.startsWith(`${EXAM_RESULTS_DIR_PATH}/`)
            && normalizedPath.toLowerCase().endsWith(".md");
    }

    private isVaultCoachHiddenPath(path: string): boolean {
        const normalizedPath: string = normalizePath(path);
        return normalizedPath === VAULT_COACH_HIDDEN_DIR_PATH
            || normalizedPath.startsWith(`${VAULT_COACH_HIDDEN_DIR_PATH}/`);
    }
}
