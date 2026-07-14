import { Notice, normalizePath, Plugin, TAbstractFile, WorkspaceLeaf, type ListedFiles, type Stat } from "obsidian";
import { EXAM_RESULTS_DIR_PATH, VAULT_COACH_HIDDEN_DIR_PATH, VIEW_TYPE_VAULT_COACH } from "./constants";
import { ExamEngine } from "./exam/exam-engine";
import { getDefaultGreeting, isBuiltInDefaultGreeting, translate, type TranslationKey } from "./i18n";
import { VaultKnowledgeBase } from "./knowledge-base";
import { normalizeObsidianMarkdown } from "./markdown-normalizer";
import { VaultCoachPersistentStore } from "./persistent-store";
import { AdvancedRagEngine } from "./rag-engine";
import { createDefaultSettings, DEFAULT_SETTINGS, VaultCoachSettingTab } from "./settings";
import { EmbeddedExactVectorStore } from "./vector-store";
import type {
    AnswerSource,
    AssistantAnswer,
    ChatMessage,
    ExamEvaluationItem,
    ExamFileOption,
    ExamGenerationOptions,
    ExamHistoryItem,
    ExamQuestion,
    ExamScopeAnalysisResult,
    ExamScopeSelection,
    ExamScopeSnapshot,
    ExamScopeOption,
    ExamSession,
    IndexedChunk,
    KnowledgeBaseSnapshot,
    KnowledgeBaseStats,
    KnowledgeBaseSyncResult,
    KnowledgeIndexBusyPhase,
    KnowledgeIndexBusyState,
    MemoryItem,
    MemorySearchHit,
    PersistedPluginState,
    RetrievalMode,
    StreamHandlers,
    VectorIndexStats,
    VectorStore,
    VaultCoachSettings,
} from "./types";
import { VaultCoachView } from "./view";

/**
 * 插件主入口模块。
 *
 * 负责 Obsidian 生命周期、命令注册、视图注册、设置加载、索引状态机、
 * 对话/记忆持久化和考试历史文件管理。具体知识库、RAG、模型调用与考试生成逻辑
 * 分别委托给独立服务。
 */

/**
 * VaultCoach 插件主类。
 */
export default class VaultCoach extends Plugin {
    settings: VaultCoachSettings = DEFAULT_SETTINGS;

    private messages: ChatMessage[] = [];
    private memories: MemoryItem[] = [];

    private knowledgeBase!: VaultKnowledgeBase;
    private vectorStore!: VectorStore;
    private ragEngine!: AdvancedRagEngine;
    private examEngine!: ExamEngine;
    private persistentStore!: VaultCoachPersistentStore;

    private knowledgeBaseDirty = true;
    private vectorIndexDirty = true;
    private runtimeRetrievalMode: RetrievalMode = DEFAULT_SETTINGS.defaultRetrievalMode;

    // 自动增量同步所需的队列与计时器。
    private readonly pendingChangedKnowledgePaths: Set<string> = new Set<string>();
    private autoIndexDebounceTimer: number | null = null;
    private autoIndexMaxWaitTimer: number | null = null;
    private isSyncingKnowledgeBase = false;
    private activeKnowledgeIndexAbortController: AbortController | null = null;
    private knowledgeIndexBusyState: KnowledgeIndexBusyState = {
        busy: false,
        phase: null,
        startedAt: null,
    };
    private lastAutoIndexAt: number | null = null;
    private hasShownOllamaEmbeddingCpuFallbackNotice = false;

    /**
     * 获取本地化文案。
     */
    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    /**
     * Obsidian 加载插件时调用。
     *
     * 这里只做轻量初始化、状态恢复和命令/视图注册；实际索引构建按需触发。
     */
    async onload(): Promise<void> {
        await this.loadSettings();

        this.runtimeRetrievalMode = this.settings.defaultRetrievalMode;
        this.persistentStore = new VaultCoachPersistentStore(this.app, this.manifest.id);
        this.knowledgeBase = new VaultKnowledgeBase(this.app, () => this.settings);
        this.vectorStore = new EmbeddedExactVectorStore(this.persistentStore);
        this.ragEngine = new AdvancedRagEngine(
            this.knowledgeBase,
            this.vectorStore,
            () => this.settings,
            () => this.runtimeRetrievalMode,
            () => this.getCloudApiKey(),
        );
        this.examEngine = new ExamEngine(
            this.app,
            this.knowledgeBase,
            () => this.settings,
            () => this.getCloudApiKey(),
        );

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

        this.addCommand({
            id: "stop-knowledge-index",
            name: this.t("command.stopKnowledgeIndex"),
            callback: () => {
                this.abortKnowledgeIndexBuild(true);
            },
        });

        this.addCommand({
            id: "clear-knowledge-index",
            name: this.t("command.clearKnowledgeIndex"),
            callback: async () => {
                await this.clearKnowledgeIndex(true);
            },
        });

        this.addRibbonIcon("message-square", this.t("ribbon.openVaultCoach"), () => {
            void this.activateView();
        });

        this.addSettingTab(new VaultCoachSettingTab(this.app, this));
        this.registerVaultEvents();

        this.app.workspace.onLayoutReady(() => {
            if (this.settings.openInRightSidebarOnStartup) {
                void this.activateView();
            }
        });
    }

    /**
     * Obsidian 卸载插件时调用。
     */
    onunload(): void {
        this.abortKnowledgeIndexBuild(false);
        this.clearAutoIndexTimers();
    }

    /**
     * 读取并合并用户设置。
     */
    async loadSettings(): Promise<void> {
        const savedSettings: Partial<VaultCoachSettings> = ((await this.loadData()) as Partial<VaultCoachSettings> | null) ?? {};
        this.settings = Object.assign(
            {},
            createDefaultSettings(),
            savedSettings,
        );
        this.refreshBuiltInDefaultGreeting();
    }

    /**
     * 保存用户设置。
     */
    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /**
     * 如果当前欢迎语仍是内置默认值，则按当前语言刷新。
     */
    private refreshBuiltInDefaultGreeting(): boolean {
        if (this.settings.defaultGreeting.trim().length === 0 || isBuiltInDefaultGreeting(this.settings.defaultGreeting)) {
            const nextDefaultGreeting: string = getDefaultGreeting();
            if (this.settings.defaultGreeting === nextDefaultGreeting) {
                return false;
            }

            this.settings.defaultGreeting = nextDefaultGreeting;
            return true;
        }

        return false;
    }

    /**
     * 从 Obsidian SecretStorage 读取云端 API key。
     */
    getCloudApiKey(): string | null {
        const secretName = this.settings.cloudApiKeySecretName.trim();
        if (secretName.length === 0) {
            return null;
        }

        return this.app.secretStorage.getSecret(secretName);
    }

    /**
     * 标记文本知识库和向量索引都需要重建。
     */
    markKnowledgeBaseDirty(): void {
        // 文本 chunk 变化会同时使关键词索引和基于 chunk 生成的向量失效。
        this.knowledgeBaseDirty = true;
        this.vectorIndexDirty = true;
        this.refreshAllViews();
    }

    /**
     * 标记向量索引需要重建。
     */
    markVectorIndexDirty(): void {
        // Embedding 服务或模型变化不会影响文本 chunk，但旧向量不能继续作为当前索引展示。
        void this.vectorStore.clear();
        this.ragEngine.hydrateVectorStats({
            ready: false,
            vectorCount: 0,
            dimension: null,
            lastBuiltAt: null,
        });
        this.vectorIndexDirty = this.settings.enableVectorRetrieval;
        this.refreshAllViews();
    }

    /**
     * 兼容旧视图调用的知识库脏状态判断。
     */
    isKnowledgeBaseDirty(): boolean {
        return this.isTextIndexDirty();
    }

    /**
     * 文本索引是否需要重建。
     */
    isTextIndexDirty(): boolean {
        return this.knowledgeBaseDirty;
    }

    /**
     * 向量索引是否需要重建。
     */
    isVectorIndexDirty(): boolean {
        return this.vectorIndexDirty;
    }

    /**
     * 获取索引构建中的 UI 状态。
     */
    getKnowledgeIndexBusyState(): KnowledgeIndexBusyState {
        return {
            ...this.knowledgeIndexBusyState,
        };
    }

    /**
     * 请求停止当前索引构建。
     */
    abortKnowledgeIndexBuild(showNotice: boolean): void {
        const controller: AbortController | null = this.activeKnowledgeIndexAbortController;
        if (!controller || controller.signal.aborted) {
            if (showNotice) {
                new Notice(this.t("notice.index.noActiveBuild"));
            }
            return;
        }

        controller.abort(new DOMException("VaultCoach index build aborted by user.", "AbortError"));
        if (showNotice) {
            new Notice(this.t("notice.index.stopRequested"));
        }
    }

    /**
     * 清除文本索引、向量索引和知识库快照。
     */
    async clearKnowledgeIndex(showNotice: boolean): Promise<void> {
        if (this.knowledgeIndexBusyState.busy) {
            if (showNotice) {
                new Notice(this.t("notice.index.clearWhileBusy"));
            }
            return;
        }

        this.clearAutoIndexTimers();
        this.pendingChangedKnowledgePaths.clear();
        this.knowledgeBase.clearIndexData();
        await this.vectorStore.clear();
        await this.persistentStore.removeKnowledgeBaseSnapshot();
        this.ragEngine.hydrateVectorStats({
            ready: false,
            vectorCount: 0,
            dimension: null,
            lastBuiltAt: null,
        });
        this.knowledgeBaseDirty = false;
        this.vectorIndexDirty = false;
        this.lastAutoIndexAt = null;
        this.refreshAllViews();

        if (showNotice) {
            new Notice(this.t("notice.index.cleared"));
        }
    }

    /**
     * 获取知识库统计信息。
     */
    getKnowledgeBaseStats(): KnowledgeBaseStats {
        return this.knowledgeBase.getStats();
    }

    /**
     * 获取向量索引统计信息。
     */
    getVectorIndexStats(): VectorIndexStats {
        return this.ragEngine.getVectorIndexStats();
    }

    /**
     * 获取当前知识库范围说明。
     */
    getKnowledgeScopeDescription(): string {
        const stats: KnowledgeBaseStats = this.getKnowledgeBaseStats();
        return stats.scopeDescription;
    }

    /**
     * 获取本地化后的知识库范围说明。
     */
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

    /**
     * 获取考试范围目录选项。
     */
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

    /**
     * 获取考试文件选项。
     */
    getExamFileOptions(selectedFolderPaths: string[]): ExamFileOption[] {
        const normalizedFolderPaths: string[] = this.normalizeExamFolderPaths(selectedFolderPaths);
        return this.knowledgeBase.getExamFileOptions(normalizedFolderPaths);
    }

    /**
     * 获取考试范围容量快照。
     */
    getExamScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot {
        return this.knowledgeBase.getExamScopeSnapshot(this.normalizeExamScopeSelection(selection));
    }

    /**
     * 分析考试范围。
     */
    async analyzeExamScope(selection: ExamScopeSelection, options: ExamGenerationOptions = {}): Promise<ExamScopeAnalysisResult> {
        await this.ensureKnowledgeBaseReady();

        const normalizedSelection: ExamScopeSelection = this.normalizeExamScopeSelection(selection);
        return this.examEngine.analyzeScope(normalizedSelection, options);
    }

    /**
     * 创建考试会话。
     */
    async createExamSession(
        selection: ExamScopeSelection,
        questionCount: number,
        options: ExamGenerationOptions = {},
    ): Promise<ExamSession> {
        await this.ensureKnowledgeBaseReady();

        const normalizedSelection: ExamScopeSelection = this.normalizeExamScopeSelection(selection);
        const chunks: IndexedChunk[] = this.knowledgeBase.getChunksForExamScope(normalizedSelection);
        if (chunks.length === 0) {
            throw new Error(this.t("exam.notice.noChunks"));
        }

        const scopeSnapshot: ExamScopeSnapshot = this.knowledgeBase.getExamScopeSnapshot(normalizedSelection);
        const effectiveQuestionCount: number = scopeSnapshot.estimatedMaxQuestions > 0
            ? Math.min(questionCount, scopeSnapshot.estimatedMaxQuestions)
            : questionCount;
        const scopeLabel: string = normalizedSelection.selectedFolderPaths.length === 0
            ? this.t("exam.scope.fullCurrentKnowledgeBase")
            : normalizedSelection.selectedFolderPaths.join(", ");

        return this.examEngine.createExamSession(
            scopeLabel,
            normalizedSelection,
            effectiveQuestionCount,
            scopeSnapshot,
            options,
        );
    }

    /**
     * 清空考试内容画像缓存。
     */
    async clearExamProfileCache(): Promise<void> {
        await this.examEngine.clearProfileCache();
    }

    /**
     * 评分考试会话，并返回更新后的会话对象。
     */
    async evaluateExamSession(session: ExamSession, userAnswers: string[]): Promise<ExamSession> {
        const evaluation = await this.ragEngine.evaluateExamSession(session, userAnswers);
        return {
            ...session,
            userAnswers: session.questions.map((_question: ExamQuestion, index: number) => userAnswers[index]?.trim() ?? ""),
            evaluation,
            status: "submitted",
        };
    }

    /**
     * 保存考试结果到默认隐藏历史目录。
     */
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

    /**
     * 导出考试结果到用户指定目录。
     */
    async exportExamSession(session: ExamSession, targetFolderPath: string): Promise<string> {
        const normalizedFolderPath: string = await this.ensureExportFolder(targetFolderPath);
        const exportPath: string = await this.createUniqueExamResultPath(normalizedFolderPath, session);
        await this.app.vault.adapter.write(exportPath, this.formatExamSessionMarkdown(session));
        return exportPath;
    }

    /**
     * 列出考试历史记录。
     */
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

    /**
     * 读取考试历史 Markdown 内容。
     */
    async readExamHistoryContent(path: string): Promise<string> {
        const normalizedPath: string = normalizePath(path);
        if (!this.isExamResultPath(normalizedPath)) {
            throw new Error(this.t("exam.notice.invalidHistoryPath"));
        }

        return this.app.vault.adapter.read(normalizedPath);
    }

    /**
     * 删除当前考试会话对应的已保存文件。
     */
    async deleteExamSession(session: ExamSession): Promise<void> {
        if (!session.savedPath) {
            return;
        }

        const savedPath: string = normalizePath(session.savedPath);
        if (await this.app.vault.adapter.exists(savedPath)) {
            await this.app.vault.adapter.remove(savedPath);
        }
    }

    /**
     * 删除指定考试历史文件。
     */
    async deleteExamHistory(path: string): Promise<void> {
        const normalizedPath: string = normalizePath(path);
        if (!this.isExamResultPath(normalizedPath)) {
            throw new Error(this.t("exam.notice.invalidHistoryPath"));
        }

        if (await this.app.vault.adapter.exists(normalizedPath)) {
            await this.app.vault.adapter.remove(normalizedPath);
        }
    }

    /**
     * 获取当前应展示的默认欢迎语。
     */
    getEffectiveDefaultGreeting(): string {
        const configuredGreeting: string = this.settings.defaultGreeting.trim();
        if (configuredGreeting.length === 0 || isBuiltInDefaultGreeting(configuredGreeting)) {
            return getDefaultGreeting();
        }

        return this.settings.defaultGreeting;
    }

    /**
     * 获取运行时检索模式。
     */
    getRuntimeRetrievalMode(): RetrievalMode {
        return this.runtimeRetrievalMode;
    }

    /**
     * 获取当前聊天模型名，用于 UI 状态展示。
     */
    getActiveChatModelName(): string {
        return this.settings.modelProvider === "openai-compatible"
            ? this.settings.cloudChatModel.trim()
            : this.settings.chatModel.trim();
    }

    /**
     * 获取当前 embedding 模型名，用于 UI 状态展示。
     */
    getActiveEmbeddingModelName(): string {
        return this.settings.embeddingProvider === "openai-compatible"
            ? this.settings.cloudEmbeddingModel.trim()
            : this.settings.embeddingModel.trim();
    }

    /**
     * 设置运行时检索模式。
     */
    setRuntimeRetrievalMode(mode: RetrievalMode): void {
        this.runtimeRetrievalMode = mode;
        this.refreshAllViews();
    }

    /**
     * 获取当前对话消息。
     */
    getMessages(): ChatMessage[] {
        return this.messages;
    }

    /**
     * 获取长期记忆数量，供视图头部展示。
     */
    getMemoryCount(): number {
        return this.memories.length;
    }

    /**
     * 追加并持久化用户消息。
     */
    async appendUserMessage(text: string): Promise<void> {
        this.messages.push({
            role: "user",
            text,
            createdAt: Date.now(),
        });
        this.trimMessages();
        await this.persistRuntimeState();
    }

    /**
     * 追加助手消息。
     */
    addAssistantMessage(text: string, sources: AnswerSource[], generationDurationMs?: number): void {
        this.messages.push({
            role: "assistant",
            text: normalizeObsidianMarkdown(text),
            createdAt: Date.now(),
            generationDurationMs,
            sources,
        });
        this.trimMessages();
    }

    /**
     * 重置当前会话。
     */
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

    /**
     * 刷新所有打开的 VaultCoach 视图。
     */
    refreshAllViews(): void {
        const leaves: WorkspaceLeaf[] = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH);
        for (const leaf of leaves) {
            const view = leaf.view;
            if (view instanceof VaultCoachView) {
                view.refresh();
            }
        }
    }

    /**
     * 标记知识索引进入 busy 状态。
     */
    private setKnowledgeIndexBusy(phase: KnowledgeIndexBusyPhase): void {
        const previousStartedAt: number | null = this.knowledgeIndexBusyState.startedAt;
        this.knowledgeIndexBusyState = {
            busy: true,
            phase,
            startedAt: previousStartedAt ?? Date.now(),
        };
        this.refreshAllViews();
    }

    /**
     * 标记知识索引回到 idle 状态。
     */
    private setKnowledgeIndexIdle(): void {
        if (!this.knowledgeIndexBusyState.busy) {
            return;
        }

        this.knowledgeIndexBusyState = {
            busy: false,
            phase: null,
            startedAt: null,
        };
        this.refreshAllViews();
    }

    /**
     * 启动一个索引相关操作，并建立取消信号。
     */
    private startKnowledgeIndexOperation(phase: KnowledgeIndexBusyPhase, signal?: AbortSignal): { signal: AbortSignal; ownsController: boolean } | null {
        if (!signal && this.knowledgeIndexBusyState.busy) {
            return null;
        }

        const controller: AbortController | null = signal ? null : new AbortController();
        const operationSignal: AbortSignal = signal ?? controller!.signal;
        if (controller) {
            this.activeKnowledgeIndexAbortController = controller;
        }

        this.setKnowledgeIndexBusy(phase);
        return {
            signal: operationSignal,
            ownsController: controller !== null,
        };
    }

    /**
     * 完成索引相关操作并清理状态。
     */
    private finishKnowledgeIndexOperation(operation: { signal: AbortSignal; ownsController: boolean }): void {
        if (!operation.ownsController) {
            return;
        }

        if (this.activeKnowledgeIndexAbortController?.signal === operation.signal) {
            this.activeKnowledgeIndexAbortController = null;
        }
        this.setKnowledgeIndexIdle();
    }

    /**
     * 全量重建知识库文本索引和向量索引。
     */
    async rebuildKnowledgeBase(showNotice: boolean, signal?: AbortSignal): Promise<void> {
        const operation = this.startKnowledgeIndexOperation("rebuilding", signal);
        if (!operation) {
            if (showNotice) {
                new Notice(this.t("notice.index.alreadyBuilding"));
            }
            return;
        }

        const abortSignal: AbortSignal = operation.signal;
        try {
            abortSignal.throwIfAborted();
            const textSyncResult: KnowledgeBaseSyncResult = await this.knowledgeBase.rebuildIndexDetailed(abortSignal);
            const textStats: KnowledgeBaseStats = textSyncResult.stats;

            let vectorStats: VectorIndexStats = this.ragEngine.getVectorIndexStats();
            let vectorBuildWarning = "";

            try {
                this.setKnowledgeIndexBusy("vector");
                abortSignal.throwIfAborted();
                vectorStats = await this.ragEngine.rebuildVectorIndex(abortSignal);
                this.vectorIndexDirty = false;
                this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
            } catch (vectorError: unknown) {
                if (this.isAbortError(vectorError)) {
                    throw vectorError;
                }
                console.error("[VaultCoach] 向量索引建立失败，将回退到关键词检索。", vectorError);
                vectorBuildWarning = this.getVectorIndexFailureNotice(vectorError);
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
            if (this.isAbortError(error)) {
                console.warn("[VaultCoach] 索引构建已停止。", error);
                this.knowledgeBase.clearIndexData();
                await this.vectorStore.clear();
                this.ragEngine.hydrateVectorStats({
                    ready: false,
                    vectorCount: 0,
                    dimension: null,
                    lastBuiltAt: null,
                });
                this.knowledgeBaseDirty = true;
                this.vectorIndexDirty = this.settings.enableVectorRetrieval;
                this.refreshAllViews();
                if (showNotice) {
                    new Notice(this.t("notice.index.stopped"));
                }
                return;
            }

            console.error("[VaultCoach] 重建索引失败", error);
            if (showNotice) {
                new Notice(this.t("notice.index.rebuildFailed"));
            }
        } finally {
            this.finishKnowledgeIndexOperation(operation);
        }
    }

    /**
     * 确保问答或考试操作前索引可用。
     */
    async ensureKnowledgeBaseReady(): Promise<void> {
        if (!this.knowledgeBase.isReady() || this.knowledgeBaseDirty) {
            await this.rebuildKnowledgeBase(false);
            return;
        }

        if (this.vectorIndexDirty && this.settings.enableVectorRetrieval) {
            await this.rebuildVectorIndexOnly(false);
        }
    }

    /**
     * 打开或激活右侧 VaultCoach 视图。
     */
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

    /**
     * 视图发送消息时调用，内部负责流式生成、记忆更新与持久化。
     */
    async streamAssistantTurn(userText: string, handlers?: StreamHandlers): Promise<AssistantAnswer> {
        const generationStartedAt: number = Date.now();
        let firstChunkDurationMs: number | null = null;
        const effectiveHandlers: StreamHandlers = {
            ...handlers,
            onToken: (token: string) => {
                if (firstChunkDurationMs === null && token.length > 0) {
                    firstChunkDurationMs = Math.max(0, Date.now() - generationStartedAt);
                }
                handlers?.onToken?.(token);
            },
        };
        await this.ensureKnowledgeBaseReady();

        const memoryContext: string = this.buildMemoryContext(userText);
        try {
            const answer: AssistantAnswer = await this.ragEngine.streamAnswerQuestion(
                userText,
                this.messages,
                this.getKnowledgeScopeDescription(),
                memoryContext,
                effectiveHandlers,
            );

            const generationDurationMs: number = firstChunkDurationMs ?? Math.max(0, Date.now() - generationStartedAt);
            const answerWithDuration: AssistantAnswer = {
                ...answer,
                generationDurationMs,
            };
            this.addAssistantMessage(answerWithDuration.text, answerWithDuration.sources, generationDurationMs);
            if (!effectiveHandlers.abortSignal?.aborted) {
                await this.updateLongTermMemory(userText, answerWithDuration.text);
            }
            await this.persistRuntimeState();

            return answerWithDuration;
        } finally {
            this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
        }
    }

    /**
     * 打开回答来源对应的 Obsidian 文档位置。
     */
    async openSource(source: AnswerSource): Promise<void> {
        const activeFilePath: string = this.app.workspace.getActiveFile()?.path ?? "";
        const linkTarget: string = source.locator?.type === "pdf"
            ? `${source.filePath}#page=${source.locator.pageStart}`
            : source.heading
            ? `${source.filePath}#${source.heading}`
            : source.filePath;

        await this.app.workspace.openLinkText(linkTarget, activeFilePath, false);
    }

    /**
     * 注册 vault 文件变化事件，用于自动增量同步。
     */
    private registerVaultEvents(): void {
        const queuePath = (path: string): void => {
            if (!this.isKnowledgePath(path) || this.isVaultCoachHiddenPath(path)) {
                return;
            }

            this.pendingChangedKnowledgePaths.add(path);
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

    /**
     * 安排自动增量同步。
     *
     * 累计变更达到阈值时立即同步，否则按 debounce / max wait 触发。
     */
    private scheduleAutoIndexSync(): void {
        if (!this.settings.enableAutoIndexSync) {
            return;
        }

        if (this.pendingChangedKnowledgePaths.size >= this.settings.autoIndexFileThreshold) {
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

    /**
     * 执行 pending 文件的增量同步，并只重算变更 chunk 的 embedding。
     */
    private async flushPendingKnowledgeBaseSync(showNotice: boolean): Promise<void> {
        if (this.isSyncingKnowledgeBase) {
            return;
        }

        const filePaths: string[] = Array.from(this.pendingChangedKnowledgePaths);
        if (filePaths.length === 0) {
            return;
        }

        this.isSyncingKnowledgeBase = true;
        const operation = this.startKnowledgeIndexOperation("syncing");
        if (!operation) {
            this.isSyncingKnowledgeBase = false;
            return;
        }

        const abortSignal: AbortSignal = operation.signal;
        this.pendingChangedKnowledgePaths.clear();
        this.clearAutoIndexTimers();

        try {
            abortSignal.throwIfAborted();
            if (!this.knowledgeBase.isReady()) {
                await this.rebuildKnowledgeBase(showNotice, abortSignal);
                return;
            }

            const syncResult: KnowledgeBaseSyncResult = await this.knowledgeBase.syncChangedFiles(filePaths, abortSignal);
            await this.ragEngine.syncVectorIndex(syncResult, abortSignal);
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
            if (this.isAbortError(error)) {
                console.warn("[VaultCoach] 自动增量同步已停止。", error);
                this.knowledgeBaseDirty = true;
                this.vectorIndexDirty = this.settings.enableVectorRetrieval;
                if (showNotice) {
                    new Notice(this.t("notice.index.stopped"));
                }
                return;
            }

            console.error("[VaultCoach] 自动增量同步失败", error);
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
        } finally {
            this.isSyncingKnowledgeBase = false;
            this.finishKnowledgeIndexOperation(operation);
        }
    }

    /**
     * 仅重建向量索引。
     */
    private async rebuildVectorIndexOnly(showNotice: boolean, signal?: AbortSignal): Promise<void> {
        const operation = this.startKnowledgeIndexOperation("vector", signal);
        if (!operation) {
            if (showNotice) {
                new Notice(this.t("notice.index.alreadyBuilding"));
            }
            return;
        }

        const abortSignal: AbortSignal = operation.signal;
        try {
            const vectorStats: VectorIndexStats = await this.ragEngine.rebuildVectorIndex(abortSignal);
            this.vectorIndexDirty = false;
            this.knowledgeBaseDirty = false;
            this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded();
            await this.persistKnowledgeBaseSnapshot();
            this.refreshAllViews();

            if (showNotice) {
                new Notice(this.t("notice.index.vectorComplete", { count: vectorStats.vectorCount }));
            }
        } catch (error: unknown) {
            if (this.isAbortError(error)) {
                console.warn("[VaultCoach] 向量索引构建已停止。", error);
                this.vectorIndexDirty = this.settings.enableVectorRetrieval;
                if (showNotice) {
                    new Notice(this.t("notice.index.stopped"));
                }
                return;
            }

            console.error("[VaultCoach] 向量索引重建失败", error);
            this.vectorIndexDirty = true;
            if (showNotice) {
                new Notice(this.getVectorIndexFailureNotice(error));
            }
        } finally {
            this.finishKnowledgeIndexOperation(operation);
        }
    }

    /**
     * 从本地状态文件恢复会话和长期记忆。
     */
    private async restorePersistentState(): Promise<void> {
        const state: PersistedPluginState | null = await this.persistentStore.loadRuntimeState();
        if (!state) {
            return;
        }

        this.messages = state.messages ?? [];
        this.memories = state.memories ?? [];
        this.lastAutoIndexAt = state.lastAutoIndexAt ?? null;
        const restoredGreeting: boolean = this.refreshRestoredDefaultGreeting();
        this.trimMessages();
        this.trimMemories();
        if (restoredGreeting) {
            await this.persistRuntimeState();
        }
    }

    /**
     * 恢复状态后刷新内置欢迎语。
     */
    private refreshRestoredDefaultGreeting(): boolean {
        const firstMessage: ChatMessage | undefined = this.messages[0];
        if (!firstMessage || firstMessage.role !== "assistant" || !isBuiltInDefaultGreeting(firstMessage.text)) {
            return false;
        }

        const effectiveGreeting: string = this.getEffectiveDefaultGreeting();
        if (firstMessage.text === effectiveGreeting) {
            return false;
        }

        this.messages[0] = {
            ...firstMessage,
            text: effectiveGreeting,
        };
        return true;
    }

    /**
     * 从磁盘快照恢复文本索引和向量索引统计。
     */
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
        const needsVectorStoreMigration: boolean = (snapshot.version ?? 0) < 2;

        if (needsVectorStoreMigration || snapshot.embeddingModel !== currentEmbeddingModel) {
            await this.vectorStore.clear();
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

    /**
     * 如果本会话触发过 Ollama embedding CPU fallback，则展示一次提示。
     */
    private showOllamaEmbeddingCpuFallbackNoticeIfNeeded(): void {
        // CPU fallback 可能在多个批次发生，但用户提示每个插件会话只展示一次。
        if (this.hasShownOllamaEmbeddingCpuFallbackNotice) {
            return;
        }

        if (!this.ragEngine.consumeOllamaEmbeddingCpuFallbackUsed()) {
            return;
        }

        this.hasShownOllamaEmbeddingCpuFallbackNotice = true;
        new Notice(this.t("notice.index.ollamaEmbeddingCpuFallback"), 14000);
    }

    /**
     * 将向量索引失败转换为用户可读通知。
     */
    private getVectorIndexFailureNotice(error: unknown): string {
        return this.isLikelyLocalOllamaConnectionFailure(error)
            ? this.t("notice.index.ollamaConnectionFailed")
            : this.t("notice.index.vectorFailedWarning");
    }

    /**
     * 判断错误是否像本地 Ollama 连接失败。
     */
    private isLikelyLocalOllamaConnectionFailure(error: unknown): boolean {
        const message: string = this.getErrorMessage(error);
        const isOllamaEndpoint: boolean = /\/api\/(?:embed|embeddings|chat)\b/i.test(message);
        const isConnectionRefused: boolean = /ERR_CONNECTION_REFUSED|ECONNREFUSED|connection refused|failed to fetch|fetch failed/i.test(message);
        return isOllamaEndpoint && isConnectionRefused;
    }

    /**
     * 获取错误文本。
     */
    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    /**
     * 持久化运行时状态。
     */
    private async persistRuntimeState(): Promise<void> {
        const state: PersistedPluginState = {
            messages: [...this.messages],
            memories: [...this.memories],
            lastAutoIndexAt: this.lastAutoIndexAt,
        };
        await this.persistentStore.saveRuntimeState(state);
    }

    /**
     * 持久化知识库快照。
     */
    private async persistKnowledgeBaseSnapshot(): Promise<void> {
        const snapshot: KnowledgeBaseSnapshot = {
            version: 2,
            settingsSignature: this.knowledgeBase.getSettingsSignature(),
            embeddingModel: this.getEmbeddingIndexSignature(),
            stats: this.knowledgeBase.getStats(),
            vectorStats: this.ragEngine.getVectorIndexStats(),
            chunks: this.knowledgeBase.getAllChunks(),
            files: this.knowledgeBase.getFileRecords(),
        };
        await this.persistentStore.saveKnowledgeBaseSnapshot(snapshot);
    }

    /**
     * 生成影响向量索引有效性的 embedding 配置签名。
     */
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

    /**
     * 从本地长期记忆中检索与当前问题最相关的条目，并注入到 prompt。
     */
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

    /**
     * 回答结束后抽取长期记忆并做本地去重、更新和裁剪。
     */
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

    /**
     * 检索与问题相关的长期记忆。
     */
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

    /**
     * 裁剪持久化消息数量，保留欢迎语和最近上下文。
     */
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

    /**
     * 裁剪长期记忆数量，优先保留最近更新或最近访问的条目。
     */
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

    /**
     * 清理自动索引同步计时器。
     */
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

    /**
     * 识别 AbortError，避免把用户主动取消记录为普通失败。
     */
    private isAbortError(error: unknown): boolean {
        if (error instanceof DOMException) {
            return error.name === "AbortError";
        }

        if (error instanceof Error) {
            return error.name === "AbortError" || /aborted|aborterror/i.test(error.message);
        }

        return false;
    }

    /**
     * 归一化记忆文本，用于去重和匹配。
     */
    private normalizeMemoryText(text: string): string {
        return text.toLowerCase().replace(/\s+/g, " ").trim();
    }

    /**
     * 轻量 tokenizer，支持中英文混合记忆检索。
     */
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

    /**
     * 为长期记忆生成稳定 ID。
     */
    private createMemoryId(text: string): string {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `mem_${(hash >>> 0).toString(16)}`;
    }

    /**
     * 归一化考试目录路径集合。
     */
    private normalizeExamFolderPaths(folderPaths: string[]): string[] {
        return Array.from(new Set(
            folderPaths
                .map((folderPath: string) => normalizePath(folderPath.trim()).replace(/\/$/, ""))
                .filter((folderPath: string) => folderPath.length > 0 && !this.isVaultCoachHiddenPath(folderPath)),
        ));
    }

    /**
     * 归一化考试范围选择。
     */
    private normalizeExamScopeSelection(selection: ExamScopeSelection): ExamScopeSelection {
        return {
            selectedFolderPaths: this.normalizeExamFolderPaths(selection.selectedFolderPaths),
            excludedFilePaths: this.normalizeExamFilePaths(selection.excludedFilePaths),
            forceIncludedFilePaths: this.normalizeExamFilePaths(selection.forceIncludedFilePaths),
        };
    }

    /**
     * 归一化考试文件路径集合。
     */
    private normalizeExamFilePaths(filePaths: string[]): string[] {
        return Array.from(new Set(
            filePaths
                .map((filePath: string) => normalizePath(filePath.trim()))
                .filter((filePath: string) => filePath.length > 0 && !this.isVaultCoachHiddenPath(filePath)),
        ));
    }

    /**
     * 确保默认考试历史目录存在。
     */
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

    /**
     * 确保用户指定的导出目录存在，并返回规范化目录路径。
     */
    private async ensureExportFolder(targetFolderPath: string): Promise<string> {
        const normalizedFolderPath: string = normalizePath(targetFolderPath.trim()).replace(/\/$/, "");
        if (normalizedFolderPath.length === 0 || normalizedFolderPath === "/") {
            return "";
        }

        await this.ensureFolderPath(normalizedFolderPath);
        return normalizedFolderPath;
    }

    /**
     * 逐级创建 vault 内目录。
     */
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

    /**
     * 创建默认考试结果文件路径。
     */
    private createExamResultPath(session: ExamSession): string {
        const safeTitle: string = this.sanitizeFileName(session.title || this.t("exam.defaultTitle"));
        return normalizePath(`${EXAM_RESULTS_DIR_PATH}/${session.id}-${safeTitle}.md`);
    }

    /**
     * 在导出目录中创建不冲突的考试结果文件路径。
     */
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

    /**
     * 将标题清理为安全文件名。
     */
    private sanitizeFileName(value: string): string {
        const sanitizedValue: string = value
            .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60);

        return sanitizedValue.length > 0 ? sanitizedValue : this.t("exam.defaultTitle");
    }

    /**
     * 将考试会话格式化为可读 Markdown。
     */
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

    /**
     * 格式化时间戳。
     */
    private formatDateTime(timestamp: number): string {
        return new Date(timestamp).toLocaleString();
    }

    /**
     * 从历史 Markdown 文件解析列表项元数据。
     */
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

    /**
     * 解析 Markdown 第一行一级标题。
     */
    private parseFirstMarkdownHeading(content: string): string | null {
        const match: RegExpExecArray | null = /^#\s+(.+)$/m.exec(content);
        return match?.[1]?.trim() ?? null;
    }

    /**
     * 从历史文件路径推断标题。
     */
    private sanitizeHistoryTitle(path: string): string {
        const fileName: string = path.split("/").pop() ?? this.t("exam.defaultTitle");
        return fileName.replace(/\.md$/i, "");
    }

    /**
     * 从 frontmatter 解析数字元数据。
     */
    private parseNumberMetadata(content: string, key: string): number | null {
        const match: RegExpExecArray | null = new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m").exec(content);
        if (!match?.[1]) {
            return null;
        }

        const parsedValue: number = Number.parseInt(match[1], 10);
        return Number.isFinite(parsedValue) ? parsedValue : null;
    }

    /**
     * 从 Markdown 正文解析创建时间。
     */
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

    /**
     * 从 Markdown 正文解析分数。
     */
    private parseScoreFromMarkdown(content: string, index: 0 | 1): number | null {
        const match: RegExpExecArray | null = /(?:得分|Score)[：:]\s*(\d+)\s*\/\s*(\d+)/m.exec(content);
        const rawValue: string | undefined = match?.[index + 1];
        if (!rawValue) {
            return null;
        }

        const parsedValue: number = Number.parseInt(rawValue, 10);
        return Number.isFinite(parsedValue) ? parsedValue : null;
    }

    /**
     * 判断路径是否为 Markdown 文件。
     */
    private isMarkdownPath(path: string): boolean {
        return path.toLowerCase().endsWith(".md");
    }

    /**
     * 判断路径是否属于当前设置启用的知识文件。
     */
    private isKnowledgePath(path: string): boolean {
        const lowerPath: string = path.toLowerCase();
        return (this.settings.enableMarkdownIndexing && lowerPath.endsWith(".md"))
            || (this.settings.enablePdfIndexing && lowerPath.endsWith(".pdf"));
    }

    /**
     * 判断路径是否是 VaultCoach 管理的考试历史文件。
     */
    private isExamResultPath(path: string): boolean {
        const normalizedPath: string = normalizePath(path);
        return normalizedPath.startsWith(`${EXAM_RESULTS_DIR_PATH}/`)
            && normalizedPath.toLowerCase().endsWith(".md");
    }

    /**
     * 判断路径是否位于 VaultCoach 隐藏目录。
     */
    private isVaultCoachHiddenPath(path: string): boolean {
        const normalizedPath: string = normalizePath(path);
        return normalizedPath === VAULT_COACH_HIDDEN_DIR_PATH
            || normalizedPath.startsWith(`${VAULT_COACH_HIDDEN_DIR_PATH}/`);
    }
}
