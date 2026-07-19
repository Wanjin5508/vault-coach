import { Notice, normalizePath, Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { VAULT_COACH_HIDDEN_DIR_PATH, VIEW_TYPE_VAULT_COACH } from "./constants";
import { createApplicationContainer, type ApplicationContainer } from "./app/application-container";
import { getDefaultGreeting, isBuiltInDefaultGreeting, translate, type TranslationKey } from "./i18n";
import { registerVaultCoachCommands, registerVaultCoachRibbon } from "./plugin/command-registry";
import type { VaultCoachPluginApi } from "./plugin-api";
import { createDefaultSettings, DEFAULT_SETTINGS, VaultCoachSettingTab } from "./settings";
import { getErrorMessage, isAbortError } from "./utils/errors";
import type { ExamEngine } from "./exam/exam-engine";
import type { ExamSessionStore } from "./exam/exam-session-store";
import type { ExamEvaluationService } from "./domain/exam/exam-evaluation-service";
import type { ChatService } from "./app/chat/chat-service";
import type { KnowledgeIndexCoordinator } from "./app/index/knowledge-index-coordinator";
import type { VaultKnowledgeBase } from "./knowledge-base";
import type { LongTermMemoryService } from "./memory/memory-service";
import type { VaultCoachPersistentStore } from "./persistent-store";
import type { AdvancedRagEngine } from "./rag-engine";
import type {
    AnswerSource,
    AssistantAnswer,
} from "./domain/retrieval/retrieval-types";
import type { ChatMessage, StreamHandlers } from "./app/chat/chat-types";
import type {
    ExamFileOption,
    ExamGenerationOptions,
    ExamHistoryItem,
    ExamQuestion,
    ExamScopeAnalysisResult,
    ExamScopeSelection,
    ExamScopeSnapshot,
    ExamScopeOption,
    ExamSession,
} from "./domain/exam/exam-types";
import type { KnowledgeBaseStats, KnowledgeBaseSyncResult } from "./domain/documents/document-types";
import type { KnowledgeBaseSnapshot, PersistedPluginState } from "./infrastructure/storage/storage-types";
import type { KnowledgeIndexBusyPhase, KnowledgeIndexBusyState } from "./app/index/index-types";
import type { RetrievalMode, VectorIndexStats, VectorStore } from "./domain/retrieval/retrieval-types";
import type { VaultCoachSettings } from "./app/config/settings-types";
import { VaultCoachView } from "./view";

/**
 * 插件编排模块。
 *
 * 负责 Obsidian 生命周期、视图注册、设置加载、索引状态机和对话编排。
 * 具体知识库、RAG、模型调用、长期记忆和考试结果存储分别委托给独立服务。
 */

/**
 * VaultCoach 插件主类。
 */
export default class VaultCoach extends Plugin implements VaultCoachPluginApi {
    settings: VaultCoachSettings = DEFAULT_SETTINGS;

    private knowledgeBase!: VaultKnowledgeBase;
    private vectorStore!: VectorStore;
    private ragEngine!: AdvancedRagEngine;
    private chatService!: ChatService;
    private examEngine!: ExamEngine;
    private examEvaluationService!: ExamEvaluationService;
    private examSessionStore!: ExamSessionStore;
    private memoryService!: LongTermMemoryService;
    private persistentStore!: VaultCoachPersistentStore;
    private indexCoordinator!: KnowledgeIndexCoordinator;
    private applicationContainer!: ApplicationContainer;
    private unsubscribeApplicationEvents: (() => void) | null = null;


    // 自动增量同步所需的队列与计时器。
    private readonly pendingChangedKnowledgePaths: Set<string> = new Set<string>();
    private autoIndexDebounceTimer: number | null = null;
    private autoIndexMaxWaitTimer: number | null = null;
    private isSyncingKnowledgeBase = false;
    private lastAutoIndexAt: number | null = null;
    private hasShownOllamaEmbeddingCpuFallbackNotice = false;

    /**
     * 获取本地化文案。
     */
    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    private get knowledgeBaseDirty(): boolean {
        return this.indexCoordinator.getTextDirty();
    }

    private set knowledgeBaseDirty(value: boolean) {
        this.indexCoordinator.setTextDirty(value);
    }

    private get vectorIndexDirty(): boolean {
        return this.indexCoordinator.getVectorDirty();
    }

    private set vectorIndexDirty(value: boolean) {
        this.indexCoordinator.setVectorDirty(value);
    }

    private get knowledgeIndexBusyState(): KnowledgeIndexBusyState {
        return this.indexCoordinator.getBusyState();
    }

    private set knowledgeIndexBusyState(value: KnowledgeIndexBusyState) {
        this.indexCoordinator.replaceBusyState(value);
    }

    private get activeKnowledgeIndexAbortController(): AbortController | null {
        return this.indexCoordinator.getActiveAbortController();
    }

    private set activeKnowledgeIndexAbortController(value: AbortController | null) {
        this.indexCoordinator.setActiveAbortController(value);
    }

    /**
     * Obsidian 加载插件时调用。
     *
     * 这里只做轻量初始化、状态恢复和命令/视图注册；实际索引构建按需触发。
     */
    async onload(): Promise<void> {
        await this.loadSettings();

        this.applicationContainer = createApplicationContainer({
            app: this.app,
            pluginId: this.manifest.id,
            getSettings: () => this.settings,
            getCloudApiKey: () => this.getCloudApiKey(),
            getDefaultGreeting: () => this.getEffectiveDefaultGreeting(),
            getKnowledgeScopeDescription: () => this.getKnowledgeScopeDescription(),
            ensureKnowledgeBaseReady: () => this.ensureKnowledgeBaseReady(),
            persistRuntimeState: () => this.persistRuntimeState(),
            onGenerationFinished: () => this.showOllamaEmbeddingCpuFallbackNoticeIfNeeded(),
            translate: (key, replacements) => this.t(key, replacements),
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
        ({
            knowledgeBase: this.knowledgeBase,
            vectorStore: this.vectorStore,
            ragEngine: this.ragEngine,
            chatService: this.chatService,
            examEngine: this.examEngine,
            examEvaluationService: this.examEvaluationService,
            examSessionStore: this.examSessionStore,
            memoryService: this.memoryService,
            persistentStore: this.persistentStore,
            indexCoordinator: this.indexCoordinator,
        } = this.applicationContainer.services);
        this.unsubscribeApplicationEvents = this.applicationContainer.application.subscribe(() => this.refreshAllViews());

        await this.restorePersistentState();
        await this.restoreKnowledgeBaseSnapshot();

        if (this.chatService.getMessages().length === 0) {
            this.resetConversation();
        }

        this.registerView(
            VIEW_TYPE_VAULT_COACH,
            (leaf: WorkspaceLeaf) => new VaultCoachView(leaf, this),
        );

        registerVaultCoachCommands(this, (key, replacements) => this.t(key, replacements));
        registerVaultCoachRibbon(this, (key, replacements) => this.t(key, replacements));

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
        this.unsubscribeApplicationEvents?.();
        this.unsubscribeApplicationEvents = null;
        void this.applicationContainer.dispose();
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
            ...this.examEngine.getScopeOptions(),
        ];
    }

    /**
     * 获取考试文件选项。
     */
    getExamFileOptions(selectedFolderPaths: string[]): ExamFileOption[] {
        const normalizedFolderPaths: string[] = this.normalizeExamFolderPaths(selectedFolderPaths);
        return this.examEngine.getFileOptions(normalizedFolderPaths);
    }

    /**
     * 获取考试范围容量快照。
     */
    getExamScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot {
        return this.examEngine.getScopeSnapshot(this.normalizeExamScopeSelection(selection));
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
        const scopeSnapshot: ExamScopeSnapshot = this.examEngine.getScopeSnapshot(normalizedSelection);
        if (!this.examEngine.hasEligibleChunks(normalizedSelection)) {
            throw new Error(this.t("exam.notice.noChunks"));
        }
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
        const evaluation = await this.examEvaluationService.evaluate(session, userAnswers);
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
        return this.examSessionStore.save(session);
    }

    /**
     * 导出考试结果到用户指定目录。
     */
    async exportExamSession(session: ExamSession, targetFolderPath: string): Promise<string> {
        return this.examSessionStore.export(session, targetFolderPath);
    }

    /**
     * 列出考试历史记录。
     */
    async listExamHistory(): Promise<ExamHistoryItem[]> {
        return this.examSessionStore.listHistory();
    }

    /**
     * 读取考试历史 Markdown 内容。
     */
    async readExamHistoryContent(path: string): Promise<string> {
        return this.examSessionStore.readHistoryContent(path);
    }

    /**
     * 删除当前考试会话对应的已保存文件。
     */
    async deleteExamSession(session: ExamSession): Promise<void> {
        await this.examSessionStore.deleteSession(session);
    }

    /**
     * 删除指定考试历史文件。
     */
    async deleteExamHistory(path: string): Promise<void> {
        await this.examSessionStore.deleteHistory(path);
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
        return this.chatService.getRuntimeRetrievalMode();
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
        this.chatService.setRuntimeRetrievalMode(mode);
        this.refreshAllViews();
    }

    /**
     * 获取当前对话消息。
     */
    getMessages(): ChatMessage[] {
        return [...this.applicationContainer.application.chat.getMessages()];
    }

    /**
     * 获取长期记忆数量，供视图头部展示。
     */
    getMemoryCount(): number {
        return this.memoryService.getCount();
    }

    /**
     * 追加并持久化用户消息。
     */
    async appendUserMessage(text: string): Promise<void> {
        await this.applicationContainer.application.chat.appendUserMessage(text);
    }

    /**
     * 追加助手消息。
     */
    addAssistantMessage(text: string, sources: AnswerSource[], generationDurationMs?: number): void {
        this.chatService.addAssistantMessage(text, sources, generationDurationMs);
    }

    /**
     * 重置当前会话。
     */
    resetConversation(): void {
        this.applicationContainer.application.chat.resetConversation();
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
                if (isAbortError(vectorError)) {
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
            if (isAbortError(error)) {
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
        return this.applicationContainer.application.chat.streamAssistantTurn(userText, handlers);
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
            if (isAbortError(error)) {
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
            if (isAbortError(error)) {
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

        this.chatService.hydrate(state.messages ?? []);
        this.memoryService.hydrate(state.memories ?? []);
        this.lastAutoIndexAt = state.lastAutoIndexAt ?? null;
        const restoredGreeting: boolean = this.refreshRestoredDefaultGreeting();
        this.memoryService.trim();
        if (restoredGreeting) {
            await this.persistRuntimeState();
        }
    }

    /**
     * 恢复状态后刷新内置欢迎语。
     */
    private refreshRestoredDefaultGreeting(): boolean {
        const messages: ChatMessage[] = this.chatService.getMessages();
        const firstMessage: ChatMessage | undefined = messages[0];
        if (!firstMessage || firstMessage.role !== "assistant" || !isBuiltInDefaultGreeting(firstMessage.text)) {
            return false;
        }

        const effectiveGreeting: string = this.getEffectiveDefaultGreeting();
        if (firstMessage.text === effectiveGreeting) {
            return false;
        }

        messages[0] = {
            ...firstMessage,
            text: effectiveGreeting,
        };
        this.chatService.hydrate(messages);
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
        const message: string = getErrorMessage(error);
        const isOllamaEndpoint: boolean = /\/api\/(?:embed|embeddings|chat)\b/i.test(message);
        const isConnectionRefused: boolean = /ERR_CONNECTION_REFUSED|ECONNREFUSED|connection refused|failed to fetch|fetch failed/i.test(message);
        return isOllamaEndpoint && isConnectionRefused;
    }

    /**
     * 持久化运行时状态。
     */
    private async persistRuntimeState(): Promise<void> {
        const state: PersistedPluginState = {
            messages: this.chatService.getMessages(),
            memories: this.memoryService.getAll(),
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
     * 判断路径是否属于当前设置启用的知识文件。
     */
    private isKnowledgePath(path: string): boolean {
        const lowerPath: string = path.toLowerCase();
        return (this.settings.enableMarkdownIndexing && lowerPath.endsWith(".md"))
            || (this.settings.enablePdfIndexing && lowerPath.endsWith(".pdf"));
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
