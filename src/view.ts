/**
 * 右侧边栏视图模块。
 *
 * 负责 VaultCoach 的全部用户界面渲染与交互事件绑定，包括问答模式、考试模式、
 * 流式回答、来源展示、考试历史和索引状态工具栏。业务逻辑通过 VaultCoach 主类调用，
 * 本文件不直接访问模型或知识库内部实现。
 */

import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, setIcon } from "obsidian";
import type VaultCoach  from "./main";
import { normalizeObsidianMarkdown } from "./markdown-normalizer";
import type {
    AnswerSource,
    AssistantAnswer,
    ChatMessage,
    ExamContentProfile,
    ExamEvaluationItem,
    ExamFileOption,
    ExamGenerationProgress,
    ExamHistoryItem,
    ExamQuestion,
    ExamScopeAnalysisResult,
    ExamScopeSelection,
    ExamScopeSnapshot,
    ExamScopeOption,
    ExamSession,
    KnowledgeIndexBusyState,
    KnowledgeBaseStats,
    RetrievalMode,
    VectorIndexStats,
} from "./types";
import { VIEW_NAME_VAULT_COACH, VIEW_TYPE_VAULT_COACH } from "./constants";
import { translate, type TranslationKey } from "./i18n";

type InteractionMode = "qa" | "exam";
type ExamViewPhase = "setup" | "generating" | "taking" | "evaluating" | "review" | "history";

/**
 * VaultCoachView 是一个自定义 ItemView。它不会像 Modal 那样弹窗，而是被放进 Obsidian 右侧边栏中。
 */
export class VaultCoachView extends ItemView {
    plugin: VaultCoach;

    // 消息列表容器，后续消息渲染会写入该元素。
    private messageListEl!: HTMLDivElement;

    // 输入框元素
    private inputEl!: HTMLTextAreaElement;

    // 发送按钮元素，单独保存出来，便于在异步请求期间禁用按钮
    private sendButtonEl!: HTMLButtonElement;
    private stopButtonEl!: HTMLButtonElement;

    // 检索模式选择元素
    private retrievalModeSelectEl!: HTMLSelectElement;

    // 当前是否正等待插件完成检索回复
    private isBusy = false;

    // 当前交互模式：普通问答或考试。
    private activeInteractionMode: InteractionMode = "qa";

    private examPhase: ExamViewPhase = "setup";
    private examSession: ExamSession | null = null;
    private selectedExamScopeIds: Set<string> = new Set<string>(["__all__"]);
    private excludedExamFilePaths: Set<string> = new Set<string>();
    private forceIncludedExamFilePaths: Set<string> = new Set<string>();
    private showExamFileManager = false;
    private examFileSearchText = "";
    private pendingExamAreaScrollTop: number | null = null;
    private examAnalysisResult: ExamScopeAnalysisResult | null = null;
    private examSmartFilteringFailed = false;
    private examProgressLabel = "";
    private activeExamAbortController: AbortController | null = null;
    private examQuestionCount = 5;
    private examAnswerEls: HTMLTextAreaElement[] = [];
    private examExportFolderPath = "VaultCoach Exams";
    private examHistoryItems: ExamHistoryItem[] = [];
    private selectedExamHistoryPath: string | null = null;
    private selectedExamHistoryContent = "";

    // 中文/日文等输入法正在组词时，Enter 应交给输入法确认候选词，而不是发送消息。
    private isComposingInput = false;

    // 回答流式输出期间使用的临时助手气泡。
    private streamingWrapperEl: HTMLDivElement | null = null;
    private streamingBubbleEl: HTMLDivElement | null = null;
    private streamingContentEl: HTMLDivElement | null = null;
    private streamingText = "";
    private activeAbortController: AbortController | null = null;
    private postOpenStyleRefreshTimers: number[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: VaultCoach) {
        super(leaf);
        this.plugin = plugin;
    }

    /**
     * 获取本地化文案。
     */
    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    /**
     * 返回当前视图的唯一类型 ID，Obsidian 通过它识别视图类型。
     */
    getViewType(): string {
        return VIEW_TYPE_VAULT_COACH;
    }

    /**
     * 返回显示给用户看的视图标题。
     */
    getDisplayText(): string {
        return VIEW_NAME_VAULT_COACH;
    }

    /**
     * 返回 Obsidian 视图标签上的图标名称。
     */
    getIcon(): string {
        return "message-square";
    }

    /**
     * 视图打开时渲染 UI，并处理首次样式加载延迟。
     */
    async onOpen(): Promise<void> {
        await Promise.resolve();
        this.render();
        this.schedulePostOpenStyleRefresh();
    }

    /**
     * 视图关闭时清理内容和延迟刷新计时器。
     */
    async onClose(): Promise<void> {
        await Promise.resolve();
        this.clearPostOpenStyleRefreshTimers();
        // 只清理插件自己的内容区。清空 containerEl 会移除 Obsidian 的视图外壳，
        // 在某些冷启动/首次打开路径下会导致后续渲染缺少正常的样式和布局上下文。
        this.contentEl.empty();
        this.contentEl.removeClass("vault-coach-view");
    }

    /**
     * 对外暴露的刷新方法，设置变化或会话重置后由主插件调用。
     */
    public refresh(): void {
        this.render();
    }

    /**
     * 安排几次延迟刷新，解决 Obsidian 首次注入 styles.css 较晚的问题。
     */
    private schedulePostOpenStyleRefresh(): void {
        this.clearPostOpenStyleRefreshTimers();

        for (const delayMs of [50, 250, 750]) {
            const timerId: number = window.setTimeout(() => {
                this.postOpenStyleRefreshTimers = this.postOpenStyleRefreshTimers.filter((id: number) => id !== timerId);
                this.refreshInitialLayoutIfStylesReady();
            }, delayMs);
            this.postOpenStyleRefreshTimers.push(timerId);
        }
    }

    /**
     * 清理首次打开样式刷新计时器。
     */
    private clearPostOpenStyleRefreshTimers(): void {
        for (const timerId of this.postOpenStyleRefreshTimers) {
            window.clearTimeout(timerId);
        }
        this.postOpenStyleRefreshTimers = [];
    }

    /**
     * 如果样式已经加载且用户尚未输入，则补一次完整渲染。
     */
    private refreshInitialLayoutIfStylesReady(): void {
        if (!this.isVaultCoachStylesheetActive()) {
            return;
        }

        this.clearPostOpenStyleRefreshTimers();

        // 首次打开时 Obsidian 可能稍晚才让插件 styles.css 生效。这里只在用户尚未开始
        // 输入/生成时补一次完整渲染，避免为了修复冷启动排版而清掉用户正在编辑的内容。
        if (this.isBusy || (this.inputEl?.isConnected && this.inputEl.value.length > 0)) {
            return;
        }

        this.render();
    }

    /**
     * 通过 sentinel CSS 变量判断插件样式是否已加载。
     */
    private isVaultCoachStylesheetActive(): boolean {
        const sentinelEl: HTMLDivElement = this.contentEl.createDiv({ cls: "vault-coach-style-sentinel" });
        const loadedValue: string = getComputedStyle(sentinelEl)
            .getPropertyValue("--vault-coach-style-loaded")
            .trim();

        sentinelEl.remove();
        return loadedValue === "1";
    }

    /**
     * 完整渲染当前视图。
     */
    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        // 给根节点添加 class，方便 css 做样式
        contentEl.addClass('vault-coach-view');

        // 最外层根容器
        const rootEl: HTMLDivElement = contentEl.createDiv({ cls: "vault-coach-root"});
        this.renderHeader(rootEl);

        if (this.activeInteractionMode === "exam") {
            this.renderExamArea(rootEl);
            this.restorePendingExamAreaScroll();
            return;
        }

        this.renderMessageArea(rootEl);
        this.renderInputArea(rootEl);
    }

    /**
     * 在重新渲染考试区域前记录滚动位置。
     */
    private renderPreservingExamScroll(): void {
        const examAreaEl: HTMLDivElement | null = this.contentEl.querySelector(".vault-coach-exam-area");
        this.pendingExamAreaScrollTop = examAreaEl?.scrollTop ?? null;
        this.render();
    }

    /**
     * 恢复考试区域滚动位置。
     */
    private restorePendingExamAreaScroll(): void {
        if (this.pendingExamAreaScrollTop === null) {
            return;
        }

        const scrollTop: number = this.pendingExamAreaScrollTop;
        this.pendingExamAreaScrollTop = null;
        const examAreaEl: HTMLDivElement | null = this.contentEl.querySelector(".vault-coach-exam-area");
        if (!examAreaEl) {
            return;
        }

        examAreaEl.scrollTop = scrollTop;
        window.requestAnimationFrame(() => {
            if (examAreaEl.isConnected) {
                examAreaEl.scrollTop = scrollTop;
            }
        });
    }

    /**
     * 渲染头部区域：
     * - 助手名称
     * - 当前索引范围
     * - 当前索引状态
     * - 重建索引 / 重置会话按钮
     */
    private renderHeader(rootEl: HTMLDivElement): void {
        const headerEl: HTMLDivElement = rootEl.createDiv({ cls: "vault-coach-header"});
        const headerTopEl: HTMLDivElement = headerEl.createDiv({ cls: "vault-coach-header-top" });
        headerTopEl.createEl("h3", { text: this.plugin.settings.assistantName});
        this.renderModeSwitch(headerTopEl);

        const textStats: KnowledgeBaseStats = this.plugin.getKnowledgeBaseStats();
        const vectorStats: VectorIndexStats = this.plugin.getVectorIndexStats();
        const indexBusyState: KnowledgeIndexBusyState = this.plugin.getKnowledgeIndexBusyState();
        const infoListEl: HTMLDivElement = headerEl.createDiv({cls: "vault-coach-header-info-grid"});

        const textIndexStatusText: string = indexBusyState.busy && indexBusyState.phase === "vector"
            ? (textStats.lastIndexedAt ? this.t("view.indexStatus.ready") : this.t("view.indexStatus.building"))
            : indexBusyState.busy
            ? this.t("view.indexStatus.building")
            : this.plugin.isTextIndexDirty()
            ? this.t("view.indexStatus.dirty")
            : (textStats.lastIndexedAt ? this.t("view.indexStatus.ready") : this.t("view.indexStatus.notBuilt"));

        const vectorIndexStatusText: string = indexBusyState.busy && indexBusyState.phase === "vector"
            ? this.t("view.indexStatus.building")
            : this.getVectorIndexStatusText(vectorStats);

        this.renderHeaderStat(infoListEl, this.t("view.stat.knowledgeScope"), this.plugin.getLocalizedKnowledgeScopeDescription());
        this.renderHeaderStat(infoListEl, this.t("view.stat.textIndex"), textIndexStatusText);
        this.renderHeaderStat(infoListEl, this.t("view.stat.vectorIndex"), vectorIndexStatusText);
        this.renderHeaderStat(infoListEl, this.t("view.stat.files"), String(textStats.fileCount));
        this.renderHeaderStat(infoListEl, this.t("view.stat.chunks"), String(textStats.chunkCount));
        this.renderHeaderStat(infoListEl, this.t("view.stat.memory"), this.t("view.stat.memoryValue", { count: this.plugin.getMemoryCount() }));

        if (indexBusyState.busy) {
            this.renderIndexBusyState(headerEl, indexBusyState);
        }

        const toolbarEl: HTMLDivElement = headerEl.createDiv({ cls: "vault-coach-toolbar" });

        if (this.activeInteractionMode === "qa") {
            this.renderQaToolbar(toolbarEl, indexBusyState.busy);
        }

        const rebuildButtonEl: HTMLButtonElement = toolbarEl.createEl("button", {
            text: indexBusyState.busy ? this.t("view.rebuildIndexBusy") : this.t("view.rebuildIndex"),
        });
        rebuildButtonEl.disabled = indexBusyState.busy || this.isBusy;
        rebuildButtonEl.addEventListener("click", () => {
            void this.handleRebuildIndex();
        });

        const clearIndexButtonEl: HTMLButtonElement = toolbarEl.createEl("button", {
            text: this.t("view.clearIndex"),
            cls: "vault-coach-danger-button",
            attr: {
                type: "button",
            },
        });
        clearIndexButtonEl.disabled = indexBusyState.busy || this.isBusy;
        clearIndexButtonEl.addEventListener("click", () => {
            void this.handleClearIndex();
        });
    }

    /**
     * 渲染索引构建中的状态条。
     */
    private renderIndexBusyState(containerEl: HTMLDivElement, state: KnowledgeIndexBusyState): void {
        const busyEl: HTMLDivElement = containerEl.createDiv({
            cls: "vault-coach-index-busy",
            attr: {
                "aria-live": "polite",
                role: "status",
            },
        });

        busyEl.createSpan({ cls: "vault-coach-thinking-spinner vault-coach-index-busy-spinner" });
        busyEl.createSpan({
            cls: "vault-coach-index-busy-text",
            text: this.getIndexBusyText(state),
        });
        const stopButtonEl: HTMLButtonElement = busyEl.createEl("button", {
            text: this.t("view.stopIndexBuild"),
            cls: "vault-coach-danger-button vault-coach-index-stop-button",
            attr: {
                type: "button",
            },
        });
        stopButtonEl.addEventListener("click", () => {
            this.plugin.abortKnowledgeIndexBuild(true);
        });
    }

    /**
     * 获取索引构建阶段对应的展示文案。
     */
    private getIndexBusyText(state: KnowledgeIndexBusyState): string {
        if (state.phase === "rebuilding") {
            return this.t("view.indexBusy.rebuilding");
        }

        if (state.phase === "syncing") {
            return this.t("view.indexBusy.syncing");
        }

        if (state.phase === "vector") {
            return this.t("view.indexBusy.vector");
        }

        return this.t("view.indexBusy.generic");
    }

    /**
     * 渲染问答模式工具栏。
     */
    private renderQaToolbar(toolbarEl: HTMLDivElement, indexBusy: boolean): void {
        const retrievalGroupEl: HTMLDivElement = toolbarEl.createDiv({ cls: "vault-coach-retrieval-group"});
        retrievalGroupEl.createSpan({text: `${this.t("view.retrievalModeLabel")} `});
        this.retrievalModeSelectEl = retrievalGroupEl.createEl("select");
        this.addRetrievalOption("keyword", this.t("view.retrieval.keyword"));
        this.addRetrievalOption("vector", this.t("view.retrieval.vector"));
        this.addRetrievalOption("hybrid", this.t("view.retrieval.hybrid"));
        this.retrievalModeSelectEl.value = this.plugin.getRuntimeRetrievalMode();
        this.retrievalModeSelectEl.disabled = this.isBusy || indexBusy;
        this.retrievalModeSelectEl.addEventListener("change", () => {
            const value: string = this.retrievalModeSelectEl.value;
            if (value === "keyword" || value === "vector" || value === "hybrid" ) {
                this.plugin.setRuntimeRetrievalMode(value);
            }
        });

        const resetButtonEl: HTMLButtonElement = toolbarEl.createEl("button", {
            text: this.t("view.resetConversation"),
        });
        resetButtonEl.disabled = this.isBusy;
        resetButtonEl.addEventListener("click", () => {
            this.plugin.resetConversation();
            void this.renderMessages();
            this.focusInput();
        });
    }

    /**
     * 渲染问答/考试模式切换。
     */
    private renderModeSwitch(headerTopEl: HTMLDivElement): void {
        const modeSwitchEl: HTMLDivElement = headerTopEl.createDiv({
            cls: "vault-coach-mode-switch",
            attr: {
                role: "group",
                "aria-label": this.t("view.modeLabel"),
            },
        });

        this.renderModeOption(modeSwitchEl, "qa", this.t("view.mode.qa"));
        this.renderModeOption(modeSwitchEl, "exam", this.t("view.mode.exam"));
    }

    /**
     * 渲染单个模式选项。
     */
    private renderModeOption(containerEl: HTMLDivElement, mode: InteractionMode, label: string): void {
        const buttonEl: HTMLButtonElement = containerEl.createEl("button", {
            text: label,
            cls: "vault-coach-mode-option",
            attr: {
                type: "button",
                "data-mode": mode,
                "aria-pressed": String(this.activeInteractionMode === mode),
            },
        });

        if (this.activeInteractionMode === mode) {
            buttonEl.addClass("is-active");
        }

        buttonEl.addEventListener("click", () => {
            if (this.activeInteractionMode === mode) {
                return;
            }

            this.activeInteractionMode = mode;
            this.render();
        });
    }

    /**
     * 渲染头部统计项。
     */
    private renderHeaderStat(containerEl: HTMLDivElement, label: string, value: string): void {
        const itemEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-header-stat" });
        itemEl.createDiv({
            cls: "vault-coach-header-stat-label",
            text: label,
        });
        itemEl.createDiv({
            cls: "vault-coach-header-stat-value",
            text: value,
        });
    }

    /**
     * 向检索模式选择器添加选项。
     */
    private addRetrievalOption(value: RetrievalMode, label: string): void {
        const optionEl: HTMLOptionElement = this.retrievalModeSelectEl.createEl("option");
        optionEl.value = value;
        optionEl.text = label;
    }

    /**
     * 渲染考试模式主体区域。
     */
    private renderExamArea(rootEl: HTMLDivElement): void {
        const examAreaEl: HTMLDivElement = rootEl.createDiv({ cls: "vault-coach-exam-area" });

        if (this.examPhase === "history") {
            this.renderExamHistory(examAreaEl);
            return;
        }

        if (this.examPhase === "generating") {
            this.renderExamBusyState(examAreaEl, this.examProgressLabel || this.t("exam.generating"), true);
            return;
        }

        if (this.examPhase === "evaluating") {
            this.renderExamBusyState(examAreaEl, this.t("exam.evaluating"));
            return;
        }

        if (!this.examSession) {
            this.renderExamSetup(examAreaEl);
            return;
        }

        if (this.examPhase === "taking" || this.examSession.status === "draft") {
            this.renderExamTaking(examAreaEl, this.examSession);
            return;
        }

        this.renderExamReview(examAreaEl, this.examSession);
    }

    /**
     * 渲染考试创建设置页。
     */
    private renderExamSetup(containerEl: HTMLDivElement): void {
        const panelEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-panel" });
        panelEl.createEl("h4", { text: this.t("exam.setup.title") });
        panelEl.createEl("p", { text: this.t("exam.setup.desc"), cls: "vault-coach-exam-description" });

        const scopeOptions: ExamScopeOption[] = this.plugin.getExamScopeOptions();
        const allScopeOption: ExamScopeOption | undefined = scopeOptions[0];

        if (!allScopeOption || allScopeOption.chunkCount === 0) {
            const emptyEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-empty" });
            emptyEl.createDiv({ cls: "vault-coach-exam-empty-title", text: this.t("exam.emptyKnowledge.title") });
            emptyEl.createDiv({ cls: "vault-coach-exam-empty-description", text: this.t("exam.emptyKnowledge.desc") });
            const historyButtonEl: HTMLButtonElement = emptyEl.createEl("button", {
                text: this.t("exam.history"),
            });
            historyButtonEl.disabled = this.isBusy;
            historyButtonEl.addEventListener("click", () => {
                void this.handleShowExamHistory();
            });
            return;
        }

        const scopeSectionEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-section" });
        scopeSectionEl.createDiv({ cls: "vault-coach-exam-section-title", text: this.t("exam.scope.title") });

        const scopeListEl: HTMLDivElement = scopeSectionEl.createDiv({ cls: "vault-coach-exam-scope-list" });
        this.renderExamScopeOption(scopeListEl, allScopeOption, true);

        const selectedFolderPaths: string[] = this.getSelectedExamFolderPaths(scopeOptions);
        const fileOptions: ExamFileOption[] = this.plugin.getExamFileOptions(selectedFolderPaths);
        const scopeSelection: ExamScopeSelection = this.getCurrentExamScopeSelection(scopeOptions);
        const scopeSnapshot: ExamScopeSnapshot = this.plugin.getExamScopeSnapshot(scopeSelection);
        this.renderExamFileScopeSection(panelEl, fileOptions, scopeSnapshot);
        if (this.examSmartFilteringFailed) {
            this.renderExamSmartFilteringFailure(panelEl);
        }
        if (this.examAnalysisResult) {
            this.renderExamAnalysisPreview(panelEl, fileOptions, this.examAnalysisResult);
        }

        const folderOptions: ExamScopeOption[] = scopeOptions.slice(1);
        if (folderOptions.length === 0) {
            scopeListEl.createDiv({
                cls: "vault-coach-exam-muted",
                text: this.t("exam.scope.noFolders"),
            });
        } else {
            scopeListEl.createDiv({
                cls: "vault-coach-exam-subtitle",
                text: this.t("exam.scope.folders"),
            });

            for (const option of folderOptions) {
                this.renderExamScopeOption(scopeListEl, option, false);
            }
        }

        if (scopeSnapshot.estimatedMaxQuestions > 0 && this.examQuestionCount > scopeSnapshot.estimatedMaxQuestions) {
            this.examQuestionCount = scopeSnapshot.estimatedMaxQuestions;
        }

        const countSectionEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-section vault-coach-exam-count-row" });
        countSectionEl.createSpan({ text: this.t("exam.questionCount") });
        const countInputEl: HTMLInputElement = countSectionEl.createEl("input");
        countInputEl.type = "number";
        countInputEl.min = "1";
        countInputEl.max = String(Math.max(1, scopeSnapshot.estimatedMaxQuestions || 10));
        countInputEl.step = "1";
        countInputEl.value = String(this.examQuestionCount);
        countInputEl.addEventListener("change", () => {
            this.examQuestionCount = this.normalizeQuestionCount(countInputEl.value, scopeSnapshot.estimatedMaxQuestions);
            countInputEl.value = String(this.examQuestionCount);
        });

        const actionRowEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-actions" });
        const startButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.plugin.settings.enableExamSmartFiltering && !this.examAnalysisResult
                ? this.t("exam.analyze")
                : this.t("exam.start"),
            cls: "mod-cta",
        });
        startButtonEl.disabled = this.isBusy || !this.hasExamScopeSelection(scopeOptions) || scopeSnapshot.eligibleChunkCount === 0;
        startButtonEl.addEventListener("click", () => {
            if (this.plugin.settings.enableExamSmartFiltering && !this.examAnalysisResult) {
                void this.handleAnalyzeExamScope(false);
                return;
            }

            void this.handleCreateExam(false);
        });

        if (this.examAnalysisResult) {
            const reanalyzeButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
                text: this.t("exam.reanalyze"),
            });
            reanalyzeButtonEl.disabled = this.isBusy;
            reanalyzeButtonEl.addEventListener("click", () => {
                void this.handleAnalyzeExamScope(true);
            });
        }

        const historyButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.history"),
        });
        historyButtonEl.disabled = this.isBusy;
        historyButtonEl.addEventListener("click", () => {
            void this.handleShowExamHistory();
        });
    }

    /**
     * 渲染单个考试范围选项。
     */
    private renderExamScopeOption(containerEl: HTMLDivElement, option: ExamScopeOption, isAllOption: boolean): void {
        const optionEl: HTMLLabelElement = containerEl.createEl("label", {
            cls: "vault-coach-exam-scope-option",
        });

        const checkboxEl: HTMLInputElement = optionEl.createEl("input");
        checkboxEl.type = "checkbox";
        checkboxEl.checked = isAllOption
            ? this.selectedExamScopeIds.has("__all__")
            : this.selectedExamScopeIds.has(option.id);

        if (checkboxEl.checked) {
            optionEl.addClass("is-selected");
        }

        const textEl: HTMLSpanElement = optionEl.createSpan({ cls: "vault-coach-exam-scope-text" });
        textEl.createSpan({
            cls: "vault-coach-exam-scope-label",
            text: isAllOption ? this.t("exam.scope.all") : option.label,
        });
        textEl.createSpan({
            cls: "vault-coach-exam-scope-meta",
            text: this.t("exam.scope.meta", {
                fileCount: option.fileCount,
                chunkCount: option.chunkCount,
            }),
        });

        checkboxEl.addEventListener("change", () => {
            this.invalidateExamAnalysis();
            if (isAllOption) {
                if (checkboxEl.checked) {
                    this.selectedExamScopeIds = new Set<string>(["__all__"]);
                } else {
                    this.selectedExamScopeIds.delete("__all__");
                }
                this.renderPreservingExamScroll();
                return;
            }

            this.selectedExamScopeIds.delete("__all__");
            if (checkboxEl.checked) {
                this.selectedExamScopeIds.add(option.id);
            } else {
                this.selectedExamScopeIds.delete(option.id);
            }

            this.renderPreservingExamScroll();
        });
    }

    /**
     * 渲染考试文件范围管理区域。
     */
    private renderExamFileScopeSection(
        containerEl: HTMLDivElement,
        fileOptions: ExamFileOption[],
        scopeSnapshot: ExamScopeSnapshot,
    ): void {
        const fileSectionEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-section" });
        fileSectionEl.createDiv({ cls: "vault-coach-exam-section-title", text: this.t("exam.files.title") });
        this.renderExamSmartFilteringToggle(fileSectionEl);

        const summaryEl: HTMLDivElement = fileSectionEl.createDiv({ cls: "vault-coach-exam-file-summary" });
        summaryEl.createDiv({
            cls: "vault-coach-exam-file-summary-main",
            text: this.t("exam.files.summary", {
                total: scopeSnapshot.totalFileCount,
                excluded: scopeSnapshot.excludedFileCount,
                eligible: scopeSnapshot.eligibleFileCount,
            }),
        });
        summaryEl.createDiv({
            cls: "vault-coach-exam-file-summary-sub",
            text: scopeSnapshot.estimatedMaxQuestions > 0
                ? this.t("exam.files.capacity", {
                    min: scopeSnapshot.estimatedMinQuestions,
                    max: scopeSnapshot.estimatedMaxQuestions,
                })
                : this.t("exam.files.capacityEmpty"),
        });

        const manageButtonEl: HTMLButtonElement = summaryEl.createEl("button", {
            text: this.showExamFileManager ? this.t("exam.files.hideManager") : this.t("exam.files.manage"),
        });
        manageButtonEl.disabled = this.isBusy || fileOptions.length === 0;
        manageButtonEl.addEventListener("click", () => {
            this.showExamFileManager = !this.showExamFileManager;
            this.renderPreservingExamScroll();
        });

        if (scopeSnapshot.eligibleChunkCount === 0) {
            fileSectionEl.createDiv({
                cls: "vault-coach-exam-warning",
                text: this.t("exam.files.noEligible"),
            });
        }

        if (this.showExamFileManager) {
            this.renderExamFileManager(fileSectionEl, fileOptions);
        }
    }

    /**
     * 渲染智能筛选开关。
     */
    private renderExamSmartFilteringToggle(containerEl: HTMLDivElement): void {
        const toggleLabelEl: HTMLLabelElement = containerEl.createEl("label", {
            cls: "vault-coach-exam-toggle",
        });
        const checkboxEl: HTMLInputElement = toggleLabelEl.createEl("input");
        checkboxEl.type = "checkbox";
        checkboxEl.checked = this.plugin.settings.enableExamSmartFiltering;
        checkboxEl.disabled = this.isBusy;
        const textEl: HTMLSpanElement = toggleLabelEl.createSpan({ cls: "vault-coach-exam-toggle-text" });
        textEl.createSpan({
            cls: "vault-coach-exam-toggle-title",
            text: this.t("settings.examSmartFiltering.name"),
        });
        textEl.createSpan({
            cls: "vault-coach-exam-toggle-description",
            text: this.t("settings.examSmartFiltering.desc"),
        });

        checkboxEl.addEventListener("change", () => {
            this.invalidateExamAnalysis();
            this.plugin.settings.enableExamSmartFiltering = checkboxEl.checked;
            void this.plugin.saveSettings().then(() => {
                this.renderPreservingExamScroll();
            });
        });
    }

    /**
     * 渲染考试文件管理器。
     */
    private renderExamFileManager(containerEl: HTMLDivElement, fileOptions: ExamFileOption[]): void {
        const managerEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-file-manager" });
        const toolbarEl: HTMLDivElement = managerEl.createDiv({ cls: "vault-coach-exam-file-toolbar" });
        const searchInputEl: HTMLInputElement = toolbarEl.createEl("input", {
            attr: {
                type: "search",
                placeholder: this.t("exam.files.search"),
            },
        });
        searchInputEl.value = this.examFileSearchText;
        searchInputEl.addEventListener("input", () => {
            this.examFileSearchText = searchInputEl.value;
            this.renderPreservingExamScroll();
        });

        const includeAllButtonEl: HTMLButtonElement = toolbarEl.createEl("button", { text: this.t("exam.files.includeAll") });
        includeAllButtonEl.addEventListener("click", () => {
            this.invalidateExamAnalysis();
            for (const option of fileOptions) {
                this.excludedExamFilePaths.delete(option.filePath);
            }
            this.renderPreservingExamScroll();
        });

        const excludeAllButtonEl: HTMLButtonElement = toolbarEl.createEl("button", { text: this.t("exam.files.excludeAll") });
        excludeAllButtonEl.addEventListener("click", () => {
            this.invalidateExamAnalysis();
            for (const option of fileOptions) {
                if (!option.permanentlyExcluded) {
                    this.excludedExamFilePaths.add(option.filePath);
                }
            }
            this.renderPreservingExamScroll();
        });

        const resetButtonEl: HTMLButtonElement = toolbarEl.createEl("button", { text: this.t("exam.files.reset") });
        resetButtonEl.addEventListener("click", () => {
            this.invalidateExamAnalysis();
            for (const option of fileOptions) {
                this.excludedExamFilePaths.delete(option.filePath);
                this.forceIncludedExamFilePaths.delete(option.filePath);
            }
            this.renderPreservingExamScroll();
        });

        const normalizedSearchText: string = this.examFileSearchText.trim().toLowerCase();
        const visibleFileOptions: ExamFileOption[] = normalizedSearchText.length === 0
            ? fileOptions
            : fileOptions.filter((option: ExamFileOption) => {
                return option.filePath.toLowerCase().includes(normalizedSearchText);
            });

        if (visibleFileOptions.length === 0) {
            managerEl.createDiv({ cls: "vault-coach-exam-muted", text: this.t("exam.files.noMatches") });
            return;
        }

        const groupedOptions: Map<string, ExamFileOption[]> = new Map<string, ExamFileOption[]>();
        for (const option of visibleFileOptions) {
            const folderLabel: string = option.parentFolder.length > 0 ? option.parentFolder : this.t("exam.files.rootFolder");
            const folderOptions: ExamFileOption[] = groupedOptions.get(folderLabel) ?? [];
            folderOptions.push(option);
            groupedOptions.set(folderLabel, folderOptions);
        }

        const listEl: HTMLDivElement = managerEl.createDiv({ cls: "vault-coach-exam-file-list" });
        for (const [folderLabel, folderOptions] of groupedOptions.entries()) {
            const folderDetailsEl: HTMLDetailsElement = listEl.createEl("details", {
                cls: "vault-coach-exam-file-folder",
                attr: { open: "true" },
            });
            folderDetailsEl.createEl("summary", {
                text: `${folderLabel} (${folderOptions.length})`,
                cls: "vault-coach-exam-file-folder-title",
            });

            for (const option of folderOptions) {
                this.renderExamFileOption(folderDetailsEl, option);
            }
        }
    }

    /**
     * 渲染单个考试文件选项。
     */
    private renderExamFileOption(containerEl: HTMLElement, option: ExamFileOption): void {
        const optionEl: HTMLLabelElement = containerEl.createEl("label", {
            cls: `vault-coach-exam-file-option ${option.permanentlyExcluded ? "is-permanently-excluded" : ""}`,
        });

        const checkboxEl: HTMLInputElement = optionEl.createEl("input");
        checkboxEl.type = "checkbox";
        checkboxEl.disabled = option.permanentlyExcluded || this.isBusy;
        checkboxEl.checked = !option.permanentlyExcluded && !this.excludedExamFilePaths.has(option.filePath);
        checkboxEl.addEventListener("change", () => {
            this.invalidateExamAnalysis();
            if (checkboxEl.checked) {
                this.excludedExamFilePaths.delete(option.filePath);
            } else {
                this.excludedExamFilePaths.add(option.filePath);
                this.forceIncludedExamFilePaths.delete(option.filePath);
            }
            this.renderPreservingExamScroll();
        });

        const bodyEl: HTMLDivElement = optionEl.createDiv({ cls: "vault-coach-exam-file-option-body" });
        bodyEl.createDiv({ cls: "vault-coach-exam-file-name", text: option.fileName });
        bodyEl.createDiv({ cls: "vault-coach-exam-file-path", text: option.filePath });

        const metaEl: HTMLDivElement = bodyEl.createDiv({ cls: "vault-coach-exam-file-meta" });
        metaEl.createSpan({
            cls: "vault-coach-exam-file-badge",
            text: this.t("exam.files.chunkCount", { count: option.chunkCount }),
        });

        if (option.permanentlyExcluded) {
            metaEl.createSpan({
                cls: "vault-coach-exam-file-badge is-muted",
                text: option.permanentExcludeReason
                    ? this.t("exam.files.permanentReason", { reason: option.permanentExcludeReason })
                    : this.t("exam.files.permanentExcluded"),
            });
        } else if (this.excludedExamFilePaths.has(option.filePath)) {
            metaEl.createSpan({
                cls: "vault-coach-exam-file-badge is-muted",
                text: this.t("exam.files.manualExcluded"),
            });
        }
    }

    /**
     * 渲染智能筛选失败后的操作区。
     */
    private renderExamSmartFilteringFailure(containerEl: HTMLDivElement): void {
        const warningEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-analysis-warning" });
        warningEl.createDiv({
            cls: "vault-coach-exam-analysis-title",
            text: this.t("exam.analysis.failedTitle"),
        });
        warningEl.createDiv({
            cls: "vault-coach-exam-analysis-text",
            text: this.t("exam.analysis.failedDesc"),
        });
        const actionRowEl: HTMLDivElement = warningEl.createDiv({ cls: "vault-coach-exam-analysis-actions" });
        const retryButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.analysis.retry"),
        });
        retryButtonEl.disabled = this.isBusy;
        retryButtonEl.addEventListener("click", () => {
            void this.handleAnalyzeExamScope(false);
        });

        const manualButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.analysis.continueManual"),
        });
        manualButtonEl.disabled = this.isBusy;
        manualButtonEl.addEventListener("click", () => {
            void this.handleCreateExam(true);
        });
    }

    /**
     * 渲染考试范围分析预览。
     */
    private renderExamAnalysisPreview(
        containerEl: HTMLDivElement,
        fileOptions: ExamFileOption[],
        analysis: ExamScopeAnalysisResult,
    ): void {
        const previewEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-analysis" });
        previewEl.createDiv({
            cls: "vault-coach-exam-analysis-title",
            text: this.t("exam.analysis.complete"),
        });
        const summaryEl: HTMLDivElement = previewEl.createDiv({ cls: "vault-coach-exam-analysis-grid" });
        this.renderExamAnalysisStat(summaryEl, this.t("exam.analysis.totalFiles"), analysis.summary.totalFiles);
        this.renderExamAnalysisStat(summaryEl, this.t("exam.analysis.ruleExcluded"), analysis.summary.ruleExcludedFiles);
        this.renderExamAnalysisStat(summaryEl, this.t("exam.analysis.semanticExcluded"), analysis.summary.semanticExcludedFiles);
        this.renderExamAnalysisStat(summaryEl, this.t("exam.analysis.partial"), analysis.summary.partialFiles);
        this.renderExamAnalysisStat(summaryEl, this.t("exam.analysis.included"), analysis.summary.includedFiles);
        this.renderExamAnalysisStat(summaryEl, this.t("exam.analysis.capacity"), `${analysis.summary.estimatedMinQuestions}–${analysis.summary.estimatedMaxQuestions}`);
        this.renderExamAnalysisStat(summaryEl, this.t("exam.analysis.cache"), `${analysis.summary.cacheHits}/${analysis.summary.cacheHits + analysis.summary.cacheMisses}`);

        const detailsEl: HTMLDetailsElement = previewEl.createEl("details", { cls: "vault-coach-exam-analysis-details" });
        detailsEl.createEl("summary", { text: this.t("exam.analysis.details") });
        const profileByPath: Map<string, ExamContentProfile> = new Map<string, ExamContentProfile>(
            analysis.profiles.map((profile: ExamContentProfile) => [profile.filePath, profile]),
        );

        for (const option of fileOptions) {
            const profile: ExamContentProfile | undefined = profileByPath.get(option.filePath);
            const rowEl: HTMLDivElement = detailsEl.createDiv({ cls: "vault-coach-exam-analysis-row" });
            const mainEl: HTMLDivElement = rowEl.createDiv({ cls: "vault-coach-exam-analysis-file" });
            const fileLinkButtonEl: HTMLButtonElement = mainEl.createEl("button", {
                cls: "vault-coach-exam-file-link",
                text: option.fileName,
                attr: {
                    type: "button",
                    title: option.filePath,
                },
            });
            fileLinkButtonEl.addEventListener("click", () => {
                void this.openExamSourcePath(option.filePath);
            });
            mainEl.createDiv({ cls: "vault-coach-exam-file-path", text: option.filePath });

            const statusEl: HTMLDivElement = rowEl.createDiv({ cls: "vault-coach-exam-analysis-status" });
            statusEl.createSpan({
                cls: `vault-coach-exam-file-badge ${this.getExamAnalysisDecisionClass(option, profile)}`,
                text: this.getExamAnalysisDecisionLabel(option, profile),
            });
            const reasonText: string = this.getExamAnalysisReasonText(option, profile);
            if (reasonText.length > 0) {
                statusEl.createSpan({
                    cls: "vault-coach-exam-file-badge is-muted",
                    text: reasonText,
                });
            }

            const actionEl: HTMLDivElement = rowEl.createDiv({ cls: "vault-coach-exam-analysis-actions" });
            if (!option.permanentlyExcluded && !this.excludedExamFilePaths.has(option.filePath)) {
                const excludeButtonEl: HTMLButtonElement = actionEl.createEl("button", {
                    text: this.t("exam.analysis.exclude"),
                });
                excludeButtonEl.disabled = this.isBusy;
                excludeButtonEl.addEventListener("click", () => {
                    this.excludedExamFilePaths.add(option.filePath);
                    this.forceIncludedExamFilePaths.delete(option.filePath);
                    void this.handleAnalyzeExamScope(false);
                });
            }

            if (
                profile
                && !option.permanentlyExcluded
                && !this.forceIncludedExamFilePaths.has(option.filePath)
                && (profile.decision === "exclude" || profile.decision === "partial")
            ) {
                const includeButtonEl: HTMLButtonElement = actionEl.createEl("button", {
                    text: this.t("exam.analysis.forceInclude"),
                });
                includeButtonEl.disabled = this.isBusy;
                includeButtonEl.addEventListener("click", () => {
                    this.forceIncludedExamFilePaths.add(option.filePath);
                    this.excludedExamFilePaths.delete(option.filePath);
                    void this.handleAnalyzeExamScope(false);
                });
            }
        }
    }

    /**
     * 渲染考试范围分析统计项。
     */
    private renderExamAnalysisStat(containerEl: HTMLDivElement, label: string, value: string | number): void {
        const itemEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-analysis-stat" });
        itemEl.createDiv({ cls: "vault-coach-exam-analysis-stat-value", text: String(value) });
        itemEl.createDiv({ cls: "vault-coach-exam-analysis-stat-label", text: label });
    }

    /**
     * 获取智能筛选决策展示标签。
     */
    private getExamAnalysisDecisionLabel(option: ExamFileOption, profile: ExamContentProfile | undefined): string {
        if (option.permanentlyExcluded) {
            return this.t("exam.analysis.ruleExcluded");
        }

        if (this.excludedExamFilePaths.has(option.filePath)) {
            return this.t("exam.files.manualExcluded");
        }

        if (this.forceIncludedExamFilePaths.has(option.filePath)) {
            return this.t("exam.analysis.forceIncluded");
        }

        if (!profile) {
            return this.t("exam.analysis.included");
        }

        if (profile.decision === "exclude") {
            return this.t("exam.analysis.semanticExcluded");
        }

        if (profile.decision === "partial") {
            return this.t("exam.analysis.partial");
        }

        return this.t("exam.analysis.included");
    }

    /**
     * 获取智能筛选决策对应的 CSS class。
     */
    private getExamAnalysisDecisionClass(option: ExamFileOption, profile: ExamContentProfile | undefined): string {
        if (option.permanentlyExcluded || this.excludedExamFilePaths.has(option.filePath) || profile?.decision === "exclude") {
            return "is-muted";
        }

        if (profile?.decision === "partial") {
            return "is-warning";
        }

        return "is-positive";
    }

    /**
     * 获取智能筛选原因展示文本。
     */
    private getExamAnalysisReasonText(option: ExamFileOption, profile: ExamContentProfile | undefined): string {
        if (option.permanentExcludeReason) {
            return option.permanentExcludeReason;
        }

        if (!profile || profile.reasonCodes.length === 0) {
            return "";
        }

        return profile.reasonCodes.join(", ");
    }

    /**
     * 渲染考试相关异步操作的忙碌态。
     */
    private renderExamBusyState(containerEl: HTMLDivElement, label: string, canCancel = false): void {
        const panelEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-panel vault-coach-exam-busy" });
        const thinkingEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-thinking-indicator" });
        thinkingEl.createSpan({
            cls: "vault-coach-thinking-spinner",
            attr: { "aria-hidden": "true" },
        });
        thinkingEl.createSpan({
            cls: "vault-coach-thinking-text",
            text: label,
        });
        const dotsEl: HTMLSpanElement = thinkingEl.createSpan({
            cls: "vault-coach-thinking-dots",
            attr: { "aria-hidden": "true" },
        });

        for (let index = 0; index < 3; index += 1) {
            dotsEl.createSpan({ cls: "vault-coach-thinking-dot", text: "." });
        }

        if (canCancel) {
            const cancelButtonEl: HTMLButtonElement = panelEl.createEl("button", {
                text: this.t("exam.cancel"),
            });
            cancelButtonEl.disabled = !this.activeExamAbortController || this.activeExamAbortController.signal.aborted;
            cancelButtonEl.addEventListener("click", () => {
                this.cancelActiveExamGeneration();
            });
        }
    }

    /**
     * 获取向量索引状态文案。
     */
    private getVectorIndexStatusText(vectorStats: VectorIndexStats): string {
        if (!this.plugin.settings.enableVectorRetrieval) {
            return this.t("view.indexStatus.vectorDisabled");
        }

        if (this.plugin.isVectorIndexDirty()) {
            return this.t("view.indexStatus.dirty");
        }

        return vectorStats.ready
            ? this.t("view.indexStatus.vectorReady", { count: vectorStats.vectorCount })
            : this.t("view.indexStatus.vectorFallback");
    }

    /**
     * 渲染考试作答页。
     */
    private renderExamTaking(containerEl: HTMLDivElement, session: ExamSession): void {
        this.examAnswerEls = [];

        const panelEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-panel" });
        const titleRowEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-title-row" });
        titleRowEl.createEl("h4", { text: session.title });
        titleRowEl.createSpan({
            cls: "vault-coach-exam-badge",
            text: session.scopeLabel,
        });
        panelEl.createEl("p", { text: this.t("exam.taking.desc"), cls: "vault-coach-exam-description" });

        session.questions.forEach((question: ExamQuestion, index: number) => {
            const questionEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-question" });
            questionEl.createDiv({
                cls: "vault-coach-exam-question-title",
                text: `${index + 1}. ${question.question}`,
            });

            const answerEl: HTMLTextAreaElement = questionEl.createEl("textarea", {
                cls: "vault-coach-exam-answer-input",
                attr: {
                    placeholder: this.t("exam.answerPlaceholder"),
                    rows: "5",
                },
            });
            answerEl.value = session.userAnswers[index] ?? "";
            answerEl.addEventListener("input", () => {
                if (!this.examSession) {
                    return;
                }

                const nextAnswers: string[] = [...this.examSession.userAnswers];
                nextAnswers[index] = answerEl.value;
                this.examSession = {
                    ...this.examSession,
                    userAnswers: nextAnswers,
                };
            });
            this.examAnswerEls.push(answerEl);
        });

        const actionRowEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-actions" });
        const submitButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.submit"),
            cls: "mod-cta",
        });
        submitButtonEl.disabled = this.isBusy;
        submitButtonEl.addEventListener("click", () => {
            void this.handleSubmitExam();
        });

        const deleteButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.delete"),
        });
        deleteButtonEl.disabled = this.isBusy;
        deleteButtonEl.addEventListener("click", () => {
            void this.handleDeleteExam();
        });
    }

    /**
     * 渲染考试结果页。
     */
    private renderExamReview(containerEl: HTMLDivElement, session: ExamSession): void {
        const evaluation = session.evaluation;
        if (!evaluation) {
            this.renderExamTaking(containerEl, session);
            return;
        }

        const panelEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-panel" });
        const titleRowEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-title-row" });
        titleRowEl.createEl("h4", { text: this.t("exam.review.title") });
        titleRowEl.createSpan({
            cls: "vault-coach-exam-badge",
            text: session.title,
        });

        const scoreEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-score-card" });
        scoreEl.createDiv({
            cls: "vault-coach-exam-score-value",
            text: `${evaluation.score} / ${evaluation.maxScore}`,
        });
        scoreEl.createDiv({
            cls: "vault-coach-exam-score-label",
            text: this.t("exam.score"),
        });

        this.renderExamReviewBlock(panelEl, this.t("exam.overallFeedback"), evaluation.overallFeedback);

        session.questions.forEach((question: ExamQuestion, index: number) => {
            const item: ExamEvaluationItem | undefined = evaluation.items.find((evaluationItem: ExamEvaluationItem) => {
                return evaluationItem.questionId === question.id;
            });

            const questionEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-question vault-coach-exam-question-review" });
            questionEl.createDiv({
                cls: "vault-coach-exam-question-title",
                text: `${index + 1}. ${question.question}`,
            });

            if (item) {
                questionEl.createDiv({
                    cls: `vault-coach-exam-question-score ${this.getExamScoreClass(item.score)}`,
                    text: `${this.t("exam.score")}: ${item.score} / ${item.maxScore}`,
                });
            }

            this.renderExamReviewBlock(questionEl, this.t("exam.userAnswer"), session.userAnswers[index]?.trim() || this.t("exam.unanswered"));
            this.renderExamReviewBlock(questionEl, this.t("exam.referenceAnswer"), question.referenceAnswer);
            this.renderExamReviewBlock(questionEl, this.t("exam.rubric"), question.rubric);

            if (item) {
                this.renderExamReviewBlock(questionEl, this.t("exam.feedback"), item.feedback);
                this.renderExamReviewBlock(questionEl, this.t("exam.improvement"), item.improvement);
            }

            if (question.sourcePaths.length > 0) {
                const sourceEl: HTMLDivElement = questionEl.createDiv({ cls: "vault-coach-exam-review-block" });
                sourceEl.createEl("strong", { cls: "vault-coach-exam-review-label", text: this.t("exam.sourcePaths") });
                const listEl: HTMLUListElement = sourceEl.createEl("ul", { cls: "vault-coach-exam-source-list" });
                for (const sourcePath of question.sourcePaths) {
                    const itemEl: HTMLLIElement = listEl.createEl("li");
                    const sourceButtonEl: HTMLButtonElement = itemEl.createEl("button", {
                        cls: "vault-coach-exam-source-link",
                        text: sourcePath,
                    });
                    sourceButtonEl.addEventListener("click", () => {
                        void this.openExamSourcePath(sourcePath);
                    });
                }
            }
        });

        if (session.savedPath) {
            panelEl.createDiv({
                cls: "vault-coach-exam-saved-path",
                text: this.t("exam.savedPath", { path: session.savedPath }),
            });
        }

        const exportEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-export" });
        exportEl.createDiv({ cls: "vault-coach-exam-section-title", text: this.t("exam.export.title") });
        exportEl.createDiv({ cls: "vault-coach-exam-description", text: this.t("exam.export.desc") });
        const exportRowEl: HTMLDivElement = exportEl.createDiv({ cls: "vault-coach-exam-export-row" });
        const exportInputEl: HTMLInputElement = exportRowEl.createEl("input", {
            attr: {
                type: "text",
                placeholder: this.t("exam.export.placeholder"),
            },
        });
        exportInputEl.value = this.examExportFolderPath;
        exportInputEl.addEventListener("input", () => {
            this.examExportFolderPath = exportInputEl.value;
        });
        const exportButtonEl: HTMLButtonElement = exportRowEl.createEl("button", {
            text: this.t("exam.export.button"),
        });
        exportButtonEl.disabled = this.isBusy;
        exportButtonEl.addEventListener("click", () => {
            void this.handleExportExam();
        });

        const actionRowEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-actions" });
        const historyButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.history"),
        });
        historyButtonEl.disabled = this.isBusy;
        historyButtonEl.addEventListener("click", () => {
            void this.handleShowExamHistory();
        });

        const deleteButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.delete"),
        });
        deleteButtonEl.disabled = this.isBusy;
        deleteButtonEl.addEventListener("click", () => {
            void this.handleDeleteExam();
        });

        const newButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.newTest"),
        });
        newButtonEl.disabled = this.isBusy;
        newButtonEl.addEventListener("click", () => {
            this.resetExamSession();
            this.render();
        });
    }

    /**
     * 渲染考试历史页。
     */
    private renderExamHistory(containerEl: HTMLDivElement): void {
        const panelEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-panel" });
        const titleRowEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-title-row" });
        titleRowEl.createEl("h4", { text: this.t("exam.history.title") });
        const backButtonEl: HTMLButtonElement = titleRowEl.createEl("button", {
            text: this.t("exam.history.back"),
        });
        backButtonEl.addEventListener("click", () => {
            this.returnFromExamHistory();
        });

        if (this.isBusy) {
            this.renderExamBusyState(panelEl, this.t("exam.history.loading"));
            return;
        }

        if (this.examHistoryItems.length === 0) {
            panelEl.createDiv({
                cls: "vault-coach-exam-empty-description",
                text: this.t("exam.history.empty"),
            });
            return;
        }

        const historyLayoutEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-history-layout" });
        const listEl: HTMLDivElement = historyLayoutEl.createDiv({ cls: "vault-coach-exam-history-list" });

        for (const item of this.examHistoryItems) {
            const itemEl: HTMLDivElement = listEl.createDiv({
                cls: `vault-coach-exam-history-item ${item.path === this.selectedExamHistoryPath ? "is-selected" : ""}`,
            });

            const buttonEl: HTMLButtonElement = itemEl.createEl("button", {
                cls: "vault-coach-exam-history-main",
            });
            buttonEl.createSpan({ cls: "vault-coach-exam-history-title", text: item.title });
            buttonEl.createSpan({ cls: "vault-coach-exam-history-meta", text: this.formatExamHistoryMeta(item) });
            buttonEl.addEventListener("click", () => {
                void this.handleLoadExamHistoryContent(item.path);
            });

            const deleteButtonEl: HTMLButtonElement = itemEl.createEl("button", {
                cls: "vault-coach-exam-history-delete",
                text: this.t("exam.history.delete"),
            });
            deleteButtonEl.addEventListener("click", () => {
                void this.handleDeleteExamHistory(item.path);
            });
        }

        const detailEl: HTMLDivElement = historyLayoutEl.createDiv({ cls: "vault-coach-exam-history-detail markdown-rendered" });
        if (this.selectedExamHistoryContent.length === 0) {
            detailEl.createDiv({
                cls: "vault-coach-exam-muted",
                text: this.t("exam.history.select"),
            });
            return;
        }

        void this.renderExamHistoryMarkdown(detailEl, this.selectedExamHistoryContent);
    }

    /**
     * 将考试历史 Markdown 渲染到容器中。
     */
    private async renderExamHistoryMarkdown(containerEl: HTMLElement, markdown: string): Promise<void> {
        containerEl.empty();
        try {
            await MarkdownRenderer.render(this.app, markdown, containerEl, "", this);
            this.bindExamHistoryInternalLinks(containerEl);
        } catch (error: unknown) {
            console.error("[VaultCoachView] 考试历史 Markdown 渲染失败", error);
            containerEl.setText(markdown);
        }
    }

    /**
     * 绑定考试历史内部链接点击事件。
     */
    private bindExamHistoryInternalLinks(containerEl: HTMLElement): void {
        containerEl.addEventListener("click", (event: MouseEvent) => {
            const targetEl: Element | null = this.getEventTargetElement(event.target);
            const linkEl: Element | null = targetEl?.closest(".internal-link") ?? null;
            if (!linkEl) {
                return;
            }

            const rawLinkTarget: string = linkEl.getAttribute("data-href")
                ?? linkEl.getAttribute("href")
                ?? linkEl.textContent
                ?? "";
            const normalizedLinkTarget: string = this.normalizeExamSourcePath(rawLinkTarget);
            if (normalizedLinkTarget.length === 0) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            void this.openExamSourcePath(normalizedLinkTarget);
        });
    }

    /**
     * 将事件目标归一化为 Element。
     */
    private getEventTargetElement(target: EventTarget | null): Element | null {
        if (!target) {
            return null;
        }

        return target instanceof Element ? target : null;
    }

    /**
     * 渲染考试结果中的文本块。
     */
    private renderExamReviewBlock(containerEl: HTMLElement, label: string, text: string): void {
        const blockEl: HTMLDivElement = containerEl.createDiv({ cls: "vault-coach-exam-review-block" });
        blockEl.createEl("strong", { cls: "vault-coach-exam-review-label", text: label });
        blockEl.createDiv({ cls: "vault-coach-exam-review-text", text });
    }

    /**
     * 渲染消息区域
     */
    private renderMessageArea(rootEl: HTMLDivElement): void {
        this.messageListEl = rootEl.createDiv({ cls: "vault-coach-message-list" });
        void this.renderMessages();
    }

    /**
     * 渲染问答输入区域。
     */
    private renderInputArea(rootEl: HTMLDivElement): void {
        const indexBusy: boolean = this.plugin.getKnowledgeIndexBusyState().busy;
        const inputAreaEl: HTMLDivElement = rootEl.createDiv({ cls: "vault-coach-input-area"});
        this.inputEl = inputAreaEl.createEl("textarea", {
            cls: "vault-coach-input",
            attr: {
                placeholder: this.t("view.inputPlaceholder"),
                rows: "4",
            },
        });
        this.inputEl.disabled = this.isBusy || indexBusy;

        const buttonRowEl: HTMLDivElement = inputAreaEl.createDiv({ cls: "vault-coach-button-row"});

        this.sendButtonEl = buttonRowEl.createEl("button", {
            text: this.t("view.send"),
            cls: "mod-cta",
        });
        this.sendButtonEl.disabled = this.isBusy || indexBusy;

        const clearButtonEl: HTMLButtonElement = buttonRowEl.createEl("button", {
            text: this.t("view.clear"),
        });
        clearButtonEl.disabled = this.isBusy;

        this.stopButtonEl = buttonRowEl.createEl("button", {
            text: this.t("view.stopGenerating"),
            cls: "vault-coach-stop-button",
        });
        this.stopButtonEl.disabled = true;

        this.renderModelStatus(buttonRowEl);

        this.sendButtonEl.addEventListener("click", () => {
            void this.handleSend();
        });

        clearButtonEl.addEventListener("click", () => {
            this.inputEl.value = "";
            this.focusInput();
        });

        this.stopButtonEl.addEventListener("click", () => {
            this.abortActiveAssistantTurn();
        });

        this.inputEl.addEventListener("compositionstart", () => {
            this.isComposingInput = true;
        });

        this.inputEl.addEventListener("compositionend", () => {
            this.isComposingInput = false;
        });

        this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
            if (this.shouldLetInputMethodHandleKey(event)) {
                return;
            }

            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void this.handleSend();
            }
        });
    }

    /**
     * 渲染当前模型状态。
     */
    private renderModelStatus(buttonRowEl: HTMLDivElement): void {
        const modelStatusEl: HTMLDivElement = buttonRowEl.createDiv({ cls: "vault-coach-model-status" });
        const chatModelName: string = this.plugin.getActiveChatModelName() || this.t("view.modelUnset");
        const embeddingModelName: string = this.plugin.getActiveEmbeddingModelName() || this.t("view.modelUnset");

        modelStatusEl.createSpan({
            cls: "vault-coach-model-status-item",
            text: this.t("view.modelStatus.chat", { model: chatModelName }),
        });
        modelStatusEl.createSpan({
            cls: "vault-coach-model-status-item",
            text: this.t("view.modelStatus.embedding", { model: embeddingModelName }),
        });
    }

    /**
     * 判断键盘事件是否应交给输入法处理。
     */
    private shouldLetInputMethodHandleKey(event: KeyboardEvent): boolean {
        return this.isComposingInput || event.isComposing || this.getLegacyKeyCode(event) === 229;
    }

    /**
     * 获取旧式 keyCode，用于兼容部分输入法事件。
     */
    private getLegacyKeyCode(event: KeyboardEvent): number | null {
        const eventRecord: Record<string, unknown> = event as unknown as Record<string, unknown>;
        const keyCode: unknown = eventRecord["keyCode"];
        return typeof keyCode === "number" ? keyCode : null;
    }

    /**
     * 重新渲染消息列表。
     *
     * MarkdownRenderer 是异步的，因此这里等待每条消息渲染完成后再统一滚动到底部。
     */
    private async renderMessages(): Promise<void> {
        this.messageListEl.empty();
        this.streamingWrapperEl = null;
        this.streamingBubbleEl = null;
        this.streamingContentEl = null;
        this.streamingText = "";

        const messages: ChatMessage[] = this.plugin.getMessages();

        // 如果没有消息，则显示空状态提示。
        if (messages.length === 0) {
            const emptyStateEl: HTMLDivElement = this.messageListEl.createDiv({
                cls: "vault-coach-empty-state",
            });
            emptyStateEl.setText(this.t("view.noMessages"));
            return;
        }

        // 逐条渲染消息。
        for (const message of messages) {
            await this.createMessageBubble(message);
        }

        // 滚动到底部，方便用户看到最新消息。
        this.scrollMessagesToBottom();

    }

    /**
     * 创建单条消息气泡。
     *
     * 消息正文统一交给 MarkdownRenderer 渲染，底部栏独立承载元信息和操作按钮。
     */
    private async createMessageBubble(message: ChatMessage): Promise<void> {
        const wrapperEl: HTMLDivElement = this.messageListEl.createDiv({
            cls: `vault-coach-message-wrapper ${message.role}`,
        });

        const bubbleEl: HTMLDivElement = wrapperEl.createDiv({
            cls: `vault-coach-message-bubble ${message.role}`,
        });

        const contentEl: HTMLDivElement = bubbleEl.createDiv({
            cls: "vault-coach-message-content markdown-rendered",
        });

        const sourcePath: string = this.app.workspace.getActiveFile()?.path ?? "";
        await MarkdownRenderer.render(this.app, normalizeObsidianMarkdown(message.text), contentEl, sourcePath, this);

        this.createMessageFooter(bubbleEl, message.role, message.createdAt, () => message.text);

        // 如果是助手消息，并且携带来源，则在下方渲染折叠来源区域
        if (message.role == "assistant" && message.sources && message.sources.length > 0) {
            await this.renderSources(wrapperEl, message.sources);
        }


    }

    /**
     * 在气泡底部创建发送者、时间和复制按钮。
     */
    private createMessageFooter(
        bubbleEl: HTMLDivElement,
        role: ChatMessage["role"],
        createdAt: number,
        getText: () => string,
    ): HTMLDivElement {
        const metaEl: HTMLDivElement = bubbleEl.createDiv({
            cls: "vault-coach-message-meta",
        });
        metaEl.createSpan({
            cls: "vault-coach-message-meta-label",
            text: `${role === "user" ? this.t("view.you") : this.plugin.settings.assistantName}` +
                ` · ${this.formatTime(createdAt)}`,
        });
        this.createMessageCopyButton(metaEl, getText);

        return metaEl;
    }

    /**
     * 在气泡底部栏创建复制按钮。
     *
     * getText 使用函数而不是固定字符串，便于流式消息在最终完成时绑定最终回答内容。
     */
    private createMessageCopyButton(metaEl: HTMLDivElement, getText: () => string): HTMLButtonElement {
        const copyButtonEl: HTMLButtonElement = metaEl.createEl("button", {
            cls: "vault-coach-message-copy-button",
            attr: {
                "aria-label": this.t("view.copyMessage"),
                title: this.t("view.copyMessage"),
                type: "button",
            },
        });
        setIcon(copyButtonEl, "copy");

        copyButtonEl.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            void this.handleCopyMessage(getText(), copyButtonEl);
        });

        return copyButtonEl;
    }

    /**
     * 复制消息原始 Markdown/纯文本内容。
     */
    private async handleCopyMessage(text: string, copyButtonEl: HTMLButtonElement): Promise<void> {
        try {
            await this.writeTextToClipboard(text);
            new Notice(this.t("view.copyMessageSuccess"));
            setIcon(copyButtonEl, "check");
            window.setTimeout(() => {
                if (copyButtonEl.isConnected) {
                    setIcon(copyButtonEl, "copy");
                }
            }, 1200);
        } catch (error: unknown) {
            console.error("[VaultCoachView] 复制消息失败", error);
            new Notice(this.t("view.copyMessageFailed", { message: this.createShortErrorMessage(error) }));
        }
    }

    /**
     * 写入系统剪贴板。
     *
     * 优先使用 Clipboard API；在受限环境中回退到临时 textarea + execCommand。
     */
    private async writeTextToClipboard(text: string): Promise<void> {
        const activeWindow: Window | null = this.contentEl.ownerDocument.defaultView;
        const clipboard: Clipboard | undefined = activeWindow?.navigator.clipboard;

        if (clipboard?.writeText) {
            try {
                await clipboard.writeText(text);
                return;
            } catch (error: unknown) {
                console.warn("[VaultCoachView] Clipboard API 复制失败，将尝试回退方案。", error);
            }
        }

        this.writeTextToClipboardWithTextarea(text);
    }

    /**
     * 使用临时 textarea 执行复制，兼容 Clipboard API 不可用的环境。
     */
    private writeTextToClipboardWithTextarea(text: string): void {
        const ownerDocument: Document = this.contentEl.ownerDocument;
        const textareaEl: HTMLTextAreaElement = ownerDocument.createElement("textarea");
        textareaEl.value = text;
        textareaEl.setAttribute("readonly", "true");
        textareaEl.style.position = "fixed";
        textareaEl.style.left = "-9999px";
        textareaEl.style.top = "0";
        ownerDocument.body.appendChild(textareaEl);

        textareaEl.select();
        textareaEl.setSelectionRange(0, textareaEl.value.length);
        const succeeded: boolean = ownerDocument.execCommand("copy");
        textareaEl.remove();

        if (!succeeded) {
            throw new Error("Clipboard copy command failed.");
        }
    }

    /**
     * 渲染回答下方的“来源折叠区”。
     *
     * 这里故意没有使用 block id 或段落定位，
     * 而是仅仅使用“文件路径 + heading”的形式，符合当前阶段的要求。
     */
    private async renderSources(wrapperEl: HTMLDivElement, sources: AnswerSource[]): Promise<void> {
        const detailsEl: HTMLDetailsElement = wrapperEl.createEl("details", {
            cls: "vault-coach-source-details",
        });

        if (!this.plugin.settings.collapseSourcesByDefault) {
            detailsEl.open = true;
        }

        detailsEl.createEl("summary", {
            text: this.t("view.sources", { count: sources.length }),
        });

        const sourcePath: string = this.app.workspace.getActiveFile()?.path ?? "";
        for (const source of sources){
            const itemEl: HTMLDivElement = detailsEl.createDiv({ cls: "vault-coach-source-item"});
            const linkButtonEl: HTMLButtonElement = itemEl.createEl("button", {
                cls: "vault-coach-source-link",
            });
            const linkMarkdownEl: HTMLSpanElement = linkButtonEl.createSpan({
                cls: "vault-coach-source-link-markdown markdown-rendered",
            });
            await this.renderSourceMarkdown(this.formatSourceDisplayLink(source), linkMarkdownEl, sourcePath);

            linkButtonEl.addEventListener("click", () => {
                void this.plugin.openSource(source);
            });

            const excerptEl: HTMLDivElement = itemEl.createDiv({
                cls: "vault-coach-source-excerpt",
            });
            excerptEl.addClass("markdown-rendered");
            await this.renderSourceMarkdown(source.excerpt, excerptEl, sourcePath);
        }
    }

    /**
     * 在来源区域渲染 Markdown 摘录。
     *
     * 来源内容可能包含 Mermaid 等不适合直接嵌入的语法，因此先做安全归一化；
     * 渲染失败时回退为纯文本，避免整条回答展示中断。
     */
    private async renderSourceMarkdown(markdown: string, containerEl: HTMLElement, sourcePath: string): Promise<void> {
        const safeMarkdown: string = this.sanitizeSourceMarkdown(normalizeObsidianMarkdown(markdown));

        try {
            await MarkdownRenderer.render(this.app, safeMarkdown, containerEl, sourcePath, this);
        } catch (error: unknown) {
            console.error(this.t("view.sourceMarkdownFallback"), error);
            containerEl.empty();
            containerEl.setText(markdown);
        }
    }

    /**
     * 格式化来源按钮展示文本。
     *
     * PDF 来源使用 `#page=` 跳转锚点，Markdown 来源沿用检索层生成的 Obsidian 链接。
     */
    private formatSourceDisplayLink(source: AnswerSource): string {
        if (source.locator?.type !== "pdf" || source.pageStart === undefined) {
            return source.displayLink;
        }

        const pageStart: number = source.pageStart;
        const pageEnd: number = source.pageEnd ?? source.pageStart;
        const pageLabel: string = pageEnd === pageStart
            ? this.t("view.source.pdfPage", { page: pageStart })
            : this.t("view.source.pdfPages", { start: pageStart, end: pageEnd });
        const fileName: string = source.filePath.split("/").pop() ?? source.filePath;

        return `[[${source.filePath}#page=${pageStart}|${fileName} · ${pageLabel}]]`;
    }

    /**
     * 清理来源摘录中不适合在折叠区直接渲染的 Markdown 块。
     */
    private sanitizeSourceMarkdown(markdown: string): string {
        return markdown
            .replace(/```[ \t]*mermaid\b/gi, "```text")
            .replace(/~~~[ \t]*mermaid\b/gi, "~~~text");
    }

    /**
     * 创建临时助手气泡。
     *
     * 在首个 token 到达前显示思考状态，降低模型响应等待期间的空白感。
     */
    private beginStreamingAssistantBubble(): void {
        const wrapperEl: HTMLDivElement = this.messageListEl.createDiv({
            cls: "vault-coach-message-wrapper assistant",
        });

        const bubbleEl: HTMLDivElement = wrapperEl.createDiv({
            cls: "vault-coach-message-bubble assistant vault-coach-streaming-bubble",
        });
        const contentEl: HTMLDivElement = bubbleEl.createDiv({
            cls: "vault-coach-message-content vault-coach-streaming-content",
        });

        this.renderThinkingIndicator(contentEl);
        this.createMessageFooter(bubbleEl, "assistant", Date.now(), () => this.streamingText);

        this.streamingWrapperEl = wrapperEl;
        this.streamingBubbleEl = bubbleEl;
        this.streamingContentEl = contentEl;
        this.streamingText = "";
        this.scrollMessagesToBottom();
    }

    /**
     * 渲染助手生成中的视觉状态。
     */
    private renderThinkingIndicator(bubbleEl: HTMLDivElement): void {
        bubbleEl.empty();
        bubbleEl.addClass("vault-coach-thinking-bubble");

        const thinkingEl: HTMLDivElement = bubbleEl.createDiv({
            cls: "vault-coach-thinking-indicator",
        });

        thinkingEl.createSpan({
            cls: "vault-coach-thinking-spinner",
            attr: {
                "aria-hidden": "true",
            },
        });

        thinkingEl.createSpan({
            cls: "vault-coach-thinking-text",
            text: this.t("view.thinking"),
        });

        const dotsEl: HTMLSpanElement = thinkingEl.createSpan({
            cls: "vault-coach-thinking-dots",
            attr: {
                "aria-hidden": "true",
            },
        });

        for (let index = 0; index < 3; index += 1) {
            dotsEl.createSpan({
                cls: "vault-coach-thinking-dot",
                text: ".",
            });
        }
    }

    /**
     * 将流式 token 追加到临时气泡。
     *
     * 这里先以纯文本展示增量内容，最终完成后再统一转换为 Markdown 渲染结果。
     */
    private appendStreamingToken(token: string): void {
        if (!this.streamingBubbleEl || !this.streamingContentEl) {
            this.beginStreamingAssistantBubble();
        }

        if (this.streamingText.length === 0 && token.length > 0) {
            this.streamingContentEl?.removeClass("vault-coach-thinking-bubble");
            this.streamingContentEl?.empty();
        }

        this.streamingText += token;

        if (this.streamingContentEl) {
            this.streamingContentEl.setText(this.streamingText);
        }

        this.scrollMessagesToBottom();
    }

    /**
     * 清理当前未完成的流式助手气泡。
     */
    private clearStreamingAssistantBubble(): void {
        this.streamingWrapperEl?.remove();
        this.streamingWrapperEl = null;
        this.streamingBubbleEl = null;
        this.streamingContentEl = null;
        this.streamingText = "";
    }

    /**
     * 将流式气泡升级为最终助手消息。
     *
     * 最终态会重新走 MarkdownRenderer，并补充来源折叠区，确保展示效果与历史消息一致。
     */
    private async finalizeStreamingAssistantBubble(answer: AssistantAnswer): Promise<void> {
        const wrapperEl: HTMLDivElement | null = this.streamingWrapperEl;
        const bubbleEl: HTMLDivElement | null = this.streamingBubbleEl;
        if (!wrapperEl || !bubbleEl) {
            await this.renderMessages();
            return;
        }

        bubbleEl.removeClass("vault-coach-streaming-bubble");
        bubbleEl.removeClass("vault-coach-thinking-bubble");
        bubbleEl.empty();

        const contentEl: HTMLDivElement = bubbleEl.createDiv({
            cls: "vault-coach-message-content markdown-rendered",
        });
        const sourcePath: string = this.app.workspace.getActiveFile()?.path ?? "";
        await MarkdownRenderer.render(this.app, normalizeObsidianMarkdown(answer.text), contentEl, sourcePath, this);
        this.createMessageFooter(bubbleEl, "assistant", Date.now(), () => answer.text);

        if (answer.sources.length > 0) {
            await this.renderSources(wrapperEl, answer.sources);
        }

        this.streamingWrapperEl = null;
        this.streamingBubbleEl = null;
        this.streamingContentEl = null;
        this.streamingText = "";
        this.scrollMessagesToBottom();
    }

    /**
     * 中止当前问答生成请求。
     */
    private abortActiveAssistantTurn(): void {
        if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
            return;
        }

        this.activeAbortController.abort();
        this.stopButtonEl.disabled = true;
    }

    /**
     * 中止当前考试分析或生成请求。
     */
    private cancelActiveExamGeneration(): void {
        if (!this.activeExamAbortController || this.activeExamAbortController.signal.aborted) {
            return;
        }

        this.activeExamAbortController.abort();
        this.examProgressLabel = this.t("exam.cancelling");
        this.renderPreservingExamScroll();
    }

    /**
     * 执行考试范围智能分析。
     *
     * 分析结果会驱动文件筛选预览，不直接创建考试。
     */
    private async handleAnalyzeExamScope(forceRefresh: boolean): Promise<void> {
        if (this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.examPhase = "generating";
        this.examSession = null;
        this.examSmartFilteringFailed = false;
        this.examProgressLabel = this.t("exam.analysis.running");
        this.activeExamAbortController = new AbortController();
        this.renderPreservingExamScroll();

        try {
            const scopeSelection: ExamScopeSelection = this.getCurrentExamScopeSelection();
            this.examAnalysisResult = await this.plugin.analyzeExamScope(scopeSelection, {
                forceProfileRefresh: forceRefresh,
                abortSignal: this.activeExamAbortController.signal,
                onProgress: (progress: ExamGenerationProgress) => {
                    this.updateExamProgress(progress);
                },
            });
            this.examPhase = "setup";
        } catch (error: unknown) {
            if (this.isAbortError(error)) {
                this.examPhase = "setup";
                new Notice(this.t("exam.notice.cancelled"));
                return;
            }

            console.error("[VaultCoachView] 智能筛选失败", error);
            this.examSmartFilteringFailed = true;
            this.examPhase = "setup";
            new Notice(this.t("exam.notice.analysisFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.activeExamAbortController = null;
            this.examProgressLabel = "";
            this.renderPreservingExamScroll();
        }
    }

    /**
     * 基于当前范围创建考试会话。
     *
     * 当用户选择跳过语义筛选时，直接使用手动选择的范围生成题目。
     */
    private async handleCreateExam(skipSemanticFiltering: boolean): Promise<void> {
        if (this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.examPhase = "generating";
        this.examSession = null;
        this.examProgressLabel = this.t("exam.generating");
        this.activeExamAbortController = new AbortController();
        this.renderPreservingExamScroll();

        try {
            const scopeSelection: ExamScopeSelection = this.getCurrentExamScopeSelection();
            const session: ExamSession = await this.plugin.createExamSession(
                scopeSelection,
                this.examQuestionCount,
                {
                    analysis: skipSemanticFiltering ? undefined : this.examAnalysisResult ?? undefined,
                    skipSemanticFiltering,
                    abortSignal: this.activeExamAbortController.signal,
                    onProgress: (progress: ExamGenerationProgress) => {
                        this.updateExamProgress(progress);
                    },
                },
            );
            this.examSession = session;
            this.examAnalysisResult = null;
            this.examSmartFilteringFailed = false;
            if (session.questions.length < this.examQuestionCount) {
                new Notice(this.t("exam.notice.questionCountReduced", {
                    requested: this.examQuestionCount,
                    actual: session.questions.length,
                }));
            }
            this.examPhase = "taking";
        } catch (error: unknown) {
            if (this.isAbortError(error)) {
                this.examPhase = "setup";
                new Notice(this.t("exam.notice.cancelled"));
                return;
            }

            console.error("[VaultCoachView] 创建考试失败", error);
            this.examPhase = "setup";
            new Notice(this.t("exam.notice.createFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.activeExamAbortController = null;
            this.examProgressLabel = "";
            this.renderPreservingExamScroll();
        }
    }

    /**
     * 提交当前考试答案并请求评分。
     */
    private async handleSubmitExam(): Promise<void> {
        if (this.isBusy || !this.examSession) {
            return;
        }

        const answers: string[] = this.examAnswerEls.map((answerEl: HTMLTextAreaElement) => answerEl.value);
        this.examSession = {
            ...this.examSession,
            userAnswers: this.examSession.questions.map((_question: ExamQuestion, index: number) => answers[index] ?? ""),
        };
        this.isBusy = true;
        this.examPhase = "evaluating";
        this.render();

        try {
            const evaluatedSession: ExamSession = await this.plugin.evaluateExamSession(this.examSession, this.examSession.userAnswers);
            this.examSession = evaluatedSession;
            try {
                this.examSession = await this.plugin.saveExamSession(evaluatedSession);
            } catch (saveError: unknown) {
                console.error("[VaultCoachView] 自动保存考试结果失败", saveError);
                new Notice(this.t("exam.notice.saveFailed", { message: this.createShortErrorMessage(saveError) }));
            }
            this.examPhase = "review";
        } catch (error: unknown) {
            console.error("[VaultCoachView] 考试评分失败", error);
            this.examPhase = "taking";
            new Notice(this.t("exam.notice.evaluateFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    /**
     * 将考试结果导出为 Vault 内的 Markdown 文件。
     */
    private async handleExportExam(): Promise<void> {
        if (this.isBusy || !this.examSession) {
            return;
        }

        this.isBusy = true;
        try {
            const exportPath: string = await this.plugin.exportExamSession(this.examSession, this.examExportFolderPath);
            new Notice(this.t("exam.notice.exported", { path: exportPath }));
        } catch (error: unknown) {
            console.error("[VaultCoachView] 导出考试结果失败", error);
            new Notice(this.t("exam.notice.exportFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    /**
     * 打开考试历史列表，并刷新历史文件摘要。
     */
    private async handleShowExamHistory(): Promise<void> {
        if (this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.examPhase = "history";
        this.selectedExamHistoryPath = null;
        this.selectedExamHistoryContent = "";
        this.render();

        try {
            this.examHistoryItems = await this.plugin.listExamHistory();
        } catch (error: unknown) {
            console.error("[VaultCoachView] 读取考试历史失败", error);
            new Notice(this.t("exam.notice.historyFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    /**
     * 读取并展示指定考试历史文件。
     */
    private async handleLoadExamHistoryContent(path: string): Promise<void> {
        if (this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.selectedExamHistoryPath = path;
        this.selectedExamHistoryContent = "";
        this.render();

        try {
            this.selectedExamHistoryContent = await this.plugin.readExamHistoryContent(path);
        } catch (error: unknown) {
            console.error("[VaultCoachView] 读取考试历史内容失败", error);
            new Notice(this.t("exam.notice.historyFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    /**
     * 删除指定考试历史文件，并同步刷新历史列表。
     */
    private async handleDeleteExamHistory(path: string): Promise<void> {
        if (this.isBusy) {
            return;
        }

        this.isBusy = true;
        try {
            await this.plugin.deleteExamHistory(path);
            if (this.selectedExamHistoryPath === path) {
                this.selectedExamHistoryPath = null;
                this.selectedExamHistoryContent = "";
            }
            this.examHistoryItems = await this.plugin.listExamHistory();
            new Notice(this.t("exam.notice.deleted"));
        } catch (error: unknown) {
            console.error("[VaultCoachView] 删除考试历史失败", error);
            new Notice(this.t("exam.notice.deleteFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    /**
     * 删除当前考试会话已保存的结果文件。
     */
    private async handleDeleteExam(): Promise<void> {
        if (this.isBusy || !this.examSession) {
            return;
        }

        this.isBusy = true;
        try {
            await this.plugin.deleteExamSession(this.examSession);
            this.resetExamSession();
            new Notice(this.t("exam.notice.deleted"));
        } catch (error: unknown) {
            console.error("[VaultCoachView] 删除考试失败", error);
            new Notice(this.t("exam.notice.deleteFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    /**
     * 将界面上的范围选择转换为文件夹路径列表。
     *
     * 选择“全部知识库”时返回空数组，由下游服务解释为不限制文件夹。
     */
    private getSelectedExamFolderPaths(scopeOptions?: ExamScopeOption[]): string[] {
        if (this.selectedExamScopeIds.has("__all__")) {
            return [];
        }

        const selectedFolderPaths: string[] = [];
        for (const option of scopeOptions ?? this.plugin.getExamScopeOptions()) {
            if (option.folderPath && this.selectedExamScopeIds.has(option.id)) {
                selectedFolderPaths.push(option.folderPath);
            }
        }

        return selectedFolderPaths;
    }

    /**
     * 汇总当前考试范围选择。
     */
    private getCurrentExamScopeSelection(scopeOptions?: ExamScopeOption[]): ExamScopeSelection {
        return {
            selectedFolderPaths: this.getSelectedExamFolderPaths(scopeOptions),
            excludedFilePaths: Array.from(this.excludedExamFilePaths),
            forceIncludedFilePaths: Array.from(this.forceIncludedExamFilePaths),
        };
    }

    /**
     * 判断当前界面是否已经选中有效考试范围。
     */
    private hasExamScopeSelection(scopeOptions: ExamScopeOption[]): boolean {
        if (this.selectedExamScopeIds.has("__all__")) {
            return true;
        }

        return scopeOptions.some((option: ExamScopeOption) => {
            return option.folderPath !== null && this.selectedExamScopeIds.has(option.id);
        });
    }

    /**
     * 规范化题目数量，防止非法输入或超过当前范围可承载的题量。
     */
    private normalizeQuestionCount(value: string, maxQuestionCount = 10): number {
        const parsedValue: number = Number.parseInt(value, 10);
        if (!Number.isFinite(parsedValue)) {
            return 5;
        }

        const normalizedMaxQuestionCount: number = Math.max(1, Math.min(10, maxQuestionCount || 10));
        return Math.max(1, Math.min(normalizedMaxQuestionCount, parsedValue));
    }

    /**
     * 使当前智能分析结果失效。
     *
     * 文件范围、强制包含或排除发生变化后，都需要重新分析。
     */
    private invalidateExamAnalysis(): void {
        this.examAnalysisResult = null;
        this.examSmartFilteringFailed = false;
    }

    /**
     * 更新考试分析/生成进度提示。
     */
    private updateExamProgress(progress: ExamGenerationProgress): void {
        this.examProgressLabel = this.formatExamProgressLabel(progress);
        if (this.examPhase === "generating") {
            this.renderPreservingExamScroll();
        }
    }

    /**
     * 将内部进度阶段转换为本地化文案。
     */
    private formatExamProgressLabel(progress: ExamGenerationProgress): string {
        switch (progress.phase) {
            case "resolving-scope":
                return this.t("exam.progress.resolvingScope");
            case "rule-filtering":
                return this.t("exam.progress.ruleFiltering");
            case "semantic-filtering":
                return progress.current !== undefined && progress.total !== undefined
                    ? this.t("exam.progress.semanticFilteringCount", { current: progress.current, total: progress.total })
                    : this.t("exam.progress.semanticFiltering");
            case "planning":
                return this.t("exam.progress.planning");
            case "generating":
                return progress.current !== undefined && progress.total !== undefined
                    ? this.t("exam.progress.generatingCount", { current: progress.current, total: progress.total })
                    : this.t("exam.progress.generating");
            case "validating":
                return this.t("exam.progress.validating");
            case "repairing":
                return this.t("exam.progress.repairing");
            case "completed":
                return this.t("exam.progress.completed");
            default:
                return progress.label;
        }
    }

    /**
     * 重置考试状态并回到设置页。
     */
    private resetExamSession(): void {
        this.examSession = null;
        this.examPhase = "setup";
        this.examAnswerEls = [];
        this.invalidateExamAnalysis();
    }

    /**
     * 从历史记录视图返回到合适的考试阶段。
     */
    private returnFromExamHistory(): void {
        if (!this.examSession) {
            this.examPhase = "setup";
        } else if (this.examSession.evaluation) {
            this.examPhase = "review";
        } else {
            this.examPhase = "taking";
        }

        this.render();
    }

    /**
     * 打开考试题目或历史记录中引用的来源文件。
     */
    private async openExamSourcePath(sourcePath: string): Promise<void> {
        const normalizedSourcePath: string = this.normalizeExamSourcePath(sourcePath);
        if (normalizedSourcePath.length === 0) {
            return;
        }

        try {
            const activeFilePath: string = this.app.workspace.getActiveFile()?.path ?? "";
            await this.app.workspace.openLinkText(normalizedSourcePath, activeFilePath, false);
        } catch (error: unknown) {
            console.error("[VaultCoachView] 打开考试来源失败", error);
            new Notice(this.t("exam.notice.openSourceFailed", { message: this.createShortErrorMessage(error) }));
        }
    }

    /**
     * 兼容不同格式的来源路径，提取 Obsidian 可打开的相对路径。
     */
    private normalizeExamSourcePath(sourcePath: string): string {
        return sourcePath
            .trim()
            .replace(/^obsidian:\/\/open\?/i, "")
            .replace(/^#/, "")
            .replace(/^\[\[/, "")
            .replace(/\]\]$/, "")
            .trim();
    }

    /**
     * 根据得分返回用于样式分层的 CSS 类。
     */
    private getExamScoreClass(score: number): string {
        if (score >= 85) {
            return "is-good";
        }

        if (score >= 60) {
            return "is-medium";
        }

        return "is-low";
    }

    /**
     * 格式化考试历史列表中的日期与得分摘要。
     */
    private formatExamHistoryMeta(item: ExamHistoryItem): string {
        const dateText: string = item.createdAt
            ? this.formatDateTime(item.createdAt)
            : this.t("exam.history.unknownDate");
        const scoreText: string = item.score !== null && item.maxScore !== null
            ? `${item.score} / ${item.maxScore}`
            : this.t("exam.history.noScore");

        return `${dateText} · ${scoreText}`;
    }

    /**
     * 处理问答发送流程。
     *
     * 用户消息先入库并刷新界面，助手回答随后以流式气泡展示，完成后落为正式消息。
     */
    private async handleSend(): Promise<void> {
        const userText: string = this.inputEl.value.trim();

        if (!userText || this.isBusy || this.plugin.getKnowledgeIndexBusyState().busy) {
            return;
        }

        this.isBusy = true;
        this.activeAbortController = new AbortController();
        this.sendButtonEl.disabled = true;
        this.stopButtonEl.disabled = false;
        this.inputEl.disabled = true;
        this.retrievalModeSelectEl.disabled = true;

        try {
            this.inputEl.value = "";
            await this.plugin.appendUserMessage(userText);

            // 先刷新用户消息，再启动助手流式气泡，避免输入后界面无反馈。
            await this.renderMessages();

            this.beginStreamingAssistantBubble();

            const answer: AssistantAnswer = await this.plugin.streamAssistantTurn(userText, {
                onToken: (token: string) => {
                    this.appendStreamingToken(token);
                },
                abortSignal: this.activeAbortController.signal,
            });

            if (this.activeAbortController.signal.aborted) {
                new Notice(this.t("view.generationStopped"));
            }

            // 直接升级当前气泡，避免整区重绘造成视觉闪回。
            await this.finalizeStreamingAssistantBubble(answer);

        } catch (error: unknown) {
            if (this.isAbortError(error)) {
                this.clearStreamingAssistantBubble();
                new Notice(this.t("view.generationStopped"));
                return;
            }

            console.error("[VaultCoachView] 发送消息失败", error);
            this.clearStreamingAssistantBubble();
            new Notice(this.t("view.sendFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.activeAbortController = null;
            this.sendButtonEl.disabled = false;
            this.stopButtonEl.disabled = true;
            this.inputEl.disabled = false;
            this.retrievalModeSelectEl.disabled = false;
            this.focusInput();
        }
    }

    /**
     * 判断异常是否来自主动中止。
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
     * 手动重建知识库索引。
     */
    private async handleRebuildIndex(): Promise<void> {
        if (this.isBusy || this.plugin.getKnowledgeIndexBusyState().busy) {
            return;
        }

        this.isBusy = true;
        this.sendButtonEl?.setAttribute("disabled", "true");
        this.retrievalModeSelectEl?.setAttribute("disabled", "true");

        try {
            await this.plugin.rebuildKnowledgeBase(true);
        } finally {
            this.isBusy = false;
            this.refresh();
            if (this.activeInteractionMode === "qa") {
                this.focusInput();
            }
        }
    }

    /**
     * 清空已构建的知识库索引。
     */
    private async handleClearIndex(): Promise<void> {
        if (this.isBusy || this.plugin.getKnowledgeIndexBusyState().busy) {
            return;
        }

        await this.plugin.clearKnowledgeIndex(true);
    }

    /**
     * 聚焦问答输入框。
     */
    private focusInput(): void {
        this.inputEl?.focus();
    }

    /**
     * 将消息列表滚动到底部。
     */
    private scrollMessagesToBottom(): void {
        this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
    }

    /**
     * 格式化聊天消息时间。
     */
    private formatTime(timestamp: number): string {
        return new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    /**
     * 格式化考试历史时间。
     */
    private formatDateTime(timestamp: number): string {
        return new Date(timestamp).toLocaleString([], {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    /**
     * 生成适合 Notice 展示的短错误信息。
     */
    private createShortErrorMessage(error: unknown): string {
        const message: string = error instanceof Error ? error.message : String(error);
        const normalizedMessage: string = message.replace(/\s+/g, " ").trim();

        if (normalizedMessage.length <= 180) {
            return normalizedMessage;
        }

        return `${normalizedMessage.slice(0, 177)}...`;
    }

}
