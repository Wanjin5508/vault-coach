// 最关键的文件，用于将插件做成右侧的边栏视图

import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer } from "obsidian";
import type VaultCoach  from "./main";
import type {
    AnswerSource,
    ChatMessage,
    ExamEvaluationItem,
    ExamHistoryItem,
    ExamQuestion,
    ExamScopeOption,
    ExamSession,
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
 *
 * 第二阶段的界面重点：
 * - 支持切换 keyword / vector / hybrid
 * - 展示文本索引与向量索引状态
 * - assistant 回答按 Markdown 渲染
 * - 继续支持来源折叠与点击跳转
 */
export class VaultCoachView extends ItemView {
    plugin: VaultCoach;

    // 消息列表容器， 后面渲染消息时会往这个元素里塞内容
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

    // 仅用于前端展示的模式切换；后台考试逻辑后续再接入。
    private activeInteractionMode: InteractionMode = "qa";

    private examPhase: ExamViewPhase = "setup";
    private examSession: ExamSession | null = null;
    private selectedExamScopeIds: Set<string> = new Set<string>(["__all__"]);
    private examQuestionCount = 5;
    private examAnswerEls: HTMLTextAreaElement[] = [];
    private examExportFolderPath = "VaultCoach Exams";
    private examHistoryItems: ExamHistoryItem[] = [];
    private selectedExamHistoryPath: string | null = null;
    private selectedExamHistoryContent = "";

    // 中文/日文等输入法正在组词时，Enter 应交给输入法确认候选词，而不是发送消息。
    private isComposingInput = false;

    // 新增：回答流式输出期间使用的临时助手气泡。
    private streamingWrapperEl: HTMLDivElement | null = null;
    private streamingBubbleEl: HTMLDivElement | null = null;
    private streamingText = "";
    private activeAbortController: AbortController | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: VaultCoach) {
        super(leaf);
        this.plugin = plugin;
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    // 返回当前视图的唯一类型 ID，Obsidian 通过它识别这是哪个视图
    getViewType(): string {
        return VIEW_TYPE_VAULT_COACH;
    }

    // 返回显示给用户看的标题，通常显示在标签页标题、悬浮窗标题和视图标题
    getDisplayText(): string {
        return VIEW_NAME_VAULT_COACH;
    }

    // 返回视图图标名称，图标会显示在右侧上方标签区域
    // TODO 后续可以改成其他图标名称
    getIcon(): string {
        return "message-square";
    }

    // 当视图被打开时调用
    async onOpen(): Promise<void> {
        // 满足了"async 函数必须有 await 表达式"的 lint 规则，同时对实际行为没有任何影响
        await Promise.resolve();
        this.render();
    }

    // 当视图被关闭时调用
    async onClose(): Promise<void> {
        await Promise.resolve();
        this.containerEl.empty();
    }

    // 对外暴露的刷新方法，当 settings 变化、会话重置后，可以重新渲染界面
    public refresh(): void {
        this.render();
    }

    // render 方法，负责完整渲染界面
    // 当前写法是初学者友好的，逻辑清晰，好调试
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
            return;
        }

        this.renderMessageArea(rootEl);
        this.renderInputArea(rootEl);
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
        const infoListEl: HTMLDivElement = headerEl.createDiv({cls: "vault-coach-header-info-grid"});

        const textIndexStatusText: string = this.plugin.isTextIndexDirty()
            ? this.t("view.indexStatus.dirty")
            : (textStats.lastIndexedAt ? this.t("view.indexStatus.ready") : this.t("view.indexStatus.notBuilt"));

        const vectorIndexStatusText: string = this.getVectorIndexStatusText(vectorStats);

        this.renderHeaderStat(infoListEl, this.t("view.stat.knowledgeScope"), this.plugin.getLocalizedKnowledgeScopeDescription());
        this.renderHeaderStat(infoListEl, this.t("view.stat.textIndex"), textIndexStatusText);
        this.renderHeaderStat(infoListEl, this.t("view.stat.vectorIndex"), vectorIndexStatusText);
        this.renderHeaderStat(infoListEl, this.t("view.stat.files"), String(textStats.fileCount));
        this.renderHeaderStat(infoListEl, this.t("view.stat.chunks"), String(textStats.chunkCount));
        this.renderHeaderStat(infoListEl, this.t("view.stat.memory"), this.t("view.stat.memoryValue", { count: this.plugin.getMemoryCount() }));

        const toolbarEl: HTMLDivElement = headerEl.createDiv({ cls: "vault-coach-toolbar" });

        if (this.activeInteractionMode === "qa") {
            this.renderQaToolbar(toolbarEl);
        }

        const rebuildButtonEl: HTMLButtonElement = toolbarEl.createEl("button", {
            text: this.t("view.rebuildIndex"),
        });
        rebuildButtonEl.addEventListener("click", () => {
            void this.handleRebuildIndex();
        });
    }

    private renderQaToolbar(toolbarEl: HTMLDivElement): void {
        const retrievalGroupEl: HTMLDivElement = toolbarEl.createDiv({ cls: "vault-coach-retrieval-group"});
        retrievalGroupEl.createSpan({text: `${this.t("view.retrievalModeLabel")} `});
        this.retrievalModeSelectEl = retrievalGroupEl.createEl("select");
        this.addRetrievalOption("keyword", this.t("view.retrieval.keyword"));
        this.addRetrievalOption("vector", this.t("view.retrieval.vector"));
        this.addRetrievalOption("hybrid", this.t("view.retrieval.hybrid"));
        this.retrievalModeSelectEl.value = this.plugin.getRuntimeRetrievalMode();
        this.retrievalModeSelectEl.addEventListener("change", () => {
            const value: string = this.retrievalModeSelectEl.value;
            if (value === "keyword" || value === "vector" || value === "hybrid" ) {
                this.plugin.setRuntimeRetrievalMode(value);
            }
        });

        const resetButtonEl: HTMLButtonElement = toolbarEl.createEl("button", {
            text: this.t("view.resetConversation"),
        });
        resetButtonEl.addEventListener("click", () => {
            this.plugin.resetConversation();
            void this.renderMessages();
            this.focusInput();
        });
    }

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

    private addRetrievalOption(value: RetrievalMode, label: string): void {
        const optionEl: HTMLOptionElement = this.retrievalModeSelectEl.createEl("option");
        optionEl.value = value;
        optionEl.text = label;
    }

    private renderExamArea(rootEl: HTMLDivElement): void {
        const examAreaEl: HTMLDivElement = rootEl.createDiv({ cls: "vault-coach-exam-area" });

        if (this.examPhase === "history") {
            this.renderExamHistory(examAreaEl);
            return;
        }

        if (this.examPhase === "generating") {
            this.renderExamBusyState(examAreaEl, this.t("exam.generating"));
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

        const countSectionEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-section vault-coach-exam-count-row" });
        countSectionEl.createSpan({ text: this.t("exam.questionCount") });
        const countInputEl: HTMLInputElement = countSectionEl.createEl("input");
        countInputEl.type = "number";
        countInputEl.min = "1";
        countInputEl.max = "10";
        countInputEl.step = "1";
        countInputEl.value = String(this.examQuestionCount);
        countInputEl.addEventListener("change", () => {
            this.examQuestionCount = this.normalizeQuestionCount(countInputEl.value);
            countInputEl.value = String(this.examQuestionCount);
        });

        const actionRowEl: HTMLDivElement = panelEl.createDiv({ cls: "vault-coach-exam-actions" });
        const startButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.start"),
            cls: "mod-cta",
        });
        startButtonEl.disabled = this.isBusy || !this.hasExamScopeSelection(scopeOptions);
        startButtonEl.addEventListener("click", () => {
            void this.handleCreateExam();
        });

        const historyButtonEl: HTMLButtonElement = actionRowEl.createEl("button", {
            text: this.t("exam.history"),
        });
        historyButtonEl.disabled = this.isBusy;
        historyButtonEl.addEventListener("click", () => {
            void this.handleShowExamHistory();
        });
    }

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
            if (isAllOption) {
                if (checkboxEl.checked) {
                    this.selectedExamScopeIds = new Set<string>(["__all__"]);
                } else {
                    this.selectedExamScopeIds.delete("__all__");
                }
                this.render();
                return;
            }

            this.selectedExamScopeIds.delete("__all__");
            if (checkboxEl.checked) {
                this.selectedExamScopeIds.add(option.id);
            } else {
                this.selectedExamScopeIds.delete(option.id);
            }

            this.render();
        });
    }

    private renderExamBusyState(containerEl: HTMLDivElement, label: string): void {
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
    }

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

    private getEventTargetElement(target: EventTarget | null): Element | null {
        if (!target) {
            return null;
        }

        const nodeLikeTarget: Partial<Node> = target as Partial<Node>;
        return nodeLikeTarget.nodeType === Node.ELEMENT_NODE ? target as Element : null;
    }

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
     * 渲染输入区域
     * 
     */
    private renderInputArea(rootEl: HTMLDivElement): void {
        const inputAreaEl: HTMLDivElement = rootEl.createDiv({ cls: "vault-coach-input-area"});
        this.inputEl = inputAreaEl.createEl("textarea", {
            cls: "vault-coach-input",
            attr: {
                placeholder: this.t("view.inputPlaceholder"),
                rows: "4",
            },
        });

        const buttonRowEl: HTMLDivElement = inputAreaEl.createDiv({ cls: "vault-coach-button-row"});

        this.sendButtonEl = buttonRowEl.createEl("button", {
            text: this.t("view.send"),
            cls: "mod-cta",
        });

        const clearButtonEl: HTMLButtonElement = buttonRowEl.createEl("button", {
            text: this.t("view.clear"),
        });

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

    private shouldLetInputMethodHandleKey(event: KeyboardEvent): boolean {
        return this.isComposingInput || event.isComposing || this.getLegacyKeyCode(event) === 229;
    }

    private getLegacyKeyCode(event: KeyboardEvent): number | null {
        const eventRecord: Record<string, unknown> = event as unknown as Record<string, unknown>;
        const keyCode: unknown = eventRecord["keyCode"];
        return typeof keyCode === "number" ? keyCode : null;
    }

    /**
     * 重新渲染消息列表。
     *
     * * 这里改成 async 的原因是：
     * * - MarkdownRenderer.renderMarkdown() 是异步的；
     *   - 这样可以在渲染结束后再统一滚动到底部。
     */
    private async renderMessages(): Promise<void> {
        this.messageListEl.empty();
        this.streamingWrapperEl = null;
        this.streamingBubbleEl = null;
        this.streamingText = "";

        const messages: ChatMessage[] = this.plugin.getMessages();

        // 如果没消息，则显示空状态提示
        if (messages.length === 0) {
            const emptyStateEl: HTMLDivElement = this.messageListEl.createDiv({
                cls: "vault-coach-empty-state",
            });
            emptyStateEl.setText(this.t("view.noMessages"));
            return;
        }

        // 逐条渲染消息
        for (const message of messages) {
            await this.createMessageBubble(message);
        }

        // 滚动到最底部，方便看到最新消息
        // this.messageListEl.scrollTop = this.messageListEl.scrollHeight; 
        //* Height 是整个滚动容器的总高度， Top 是滚动条顶部距离容器顶部的距离
        this.scrollMessagesToBottom();

    }

    /**
     * 创建单条消息气泡。
     *
     * 第二阶段的关键改动：
     * - 不再使用 setText 直接显示 assistant 内容；
     * - 统一交给 MarkdownRenderer 渲染。
     */
    private async createMessageBubble(message: ChatMessage): Promise<void> {
        const wrapperEl: HTMLDivElement = this.messageListEl.createDiv({
            cls: `vault-coach-message-wrapper ${message.role}`,
        });

        // 消息头部：显示角色和时间
        const metaEl: HTMLDivElement = wrapperEl.createDiv({
            cls: "vault-coach-message-meta",
        });
        metaEl.setText(
            `${message.role === "user" ? this.t("view.you") : this.plugin.settings.assistantName}` +
            ` · ${this.formatTime(message.createdAt)}`
        );

        // 消息气泡
        const bubbleEl: HTMLDivElement = wrapperEl.createDiv({
            cls: `vault-coach-message-bubble ${message.role}`,
        });

        // 追加 Obsidian 常用的 markdown 渲染类名
        // 这样列表、标题、代码块等元素会更接近原生预览样式
        bubbleEl.addClass("markdown-rendered");

        // setText 不会保留换行显示，因此这里通过 whiteSpace = pre-wrap 让多行文本能够正确展示。
        // bubbleEl.style.whiteSpace = "pre-wrap";
        // bubbleEl.setText(message.text);
        const sourcePath: string = this.app.workspace.getActiveFile()?.path ?? "";
        await MarkdownRenderer.render(this.app, message.text, bubbleEl, sourcePath, this)

        // 如果是助手消息，并且携带来源，则在下方渲染折叠来源区域
        if (message.role == "assistant" && message.sources && message.sources.length > 0) {
            await this.renderSources(wrapperEl, message.sources);
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
            await this.renderSourceMarkdown(source.displayLink, linkMarkdownEl, sourcePath);

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

    private async renderSourceMarkdown(markdown: string, containerEl: HTMLElement, sourcePath: string): Promise<void> {
        const safeMarkdown: string = this.sanitizeSourceMarkdown(markdown);

        try {
            await MarkdownRenderer.render(this.app, safeMarkdown, containerEl, sourcePath, this);
        } catch (error: unknown) {
            console.error(this.t("view.sourceMarkdownFallback"), error);
            containerEl.empty();
            containerEl.setText(markdown);
        }
    }

    private sanitizeSourceMarkdown(markdown: string): string {
        return markdown
            .replace(/```[ \t]*mermaid\b/gi, "```text")
            .replace(/~~~[ \t]*mermaid\b/gi, "~~~text");
    }

    // 新增：创建一个临时助手气泡；真正 token 到达前显示“思考中”动画。
    private beginStreamingAssistantBubble(): void {
        const wrapperEl: HTMLDivElement = this.messageListEl.createDiv({
            cls: "vault-coach-message-wrapper assistant",
        });

        const metaEl: HTMLDivElement = wrapperEl.createDiv({
            cls: "vault-coach-message-meta",
        });
        metaEl.setText(`${this.plugin.settings.assistantName} · ${this.formatTime(Date.now())}`);

        const bubbleEl: HTMLDivElement = wrapperEl.createDiv({
            cls: "vault-coach-message-bubble assistant vault-coach-streaming-bubble", // 三个类，类似 html 的写法
        });

        this.renderThinkingIndicator(bubbleEl);

        this.streamingWrapperEl = wrapperEl;
        this.streamingBubbleEl = bubbleEl;
        this.streamingText = "";
        this.scrollMessagesToBottom();
    }

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

    // 新增：将新 token 追加到临时气泡中，降低 UI 感知延迟。
    private appendStreamingToken(token: string): void {
        if (!this.streamingBubbleEl) {
            this.beginStreamingAssistantBubble();
        }

        if (this.streamingText.length === 0 && token.length > 0) {
            this.streamingBubbleEl?.removeClass("vault-coach-thinking-bubble");
            this.streamingBubbleEl?.empty();
        }

        this.streamingText += token;

        if (this.streamingBubbleEl) {
            this.streamingBubbleEl.setText(this.streamingText);
        }

        this.scrollMessagesToBottom();
    }

    private clearStreamingAssistantBubble(): void {
        this.streamingWrapperEl?.remove();
        this.streamingWrapperEl = null;
        this.streamingBubbleEl = null;
        this.streamingText = "";
    }

    private abortActiveAssistantTurn(): void {
        if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
            return;
        }

        this.activeAbortController.abort();
        this.stopButtonEl.disabled = true;
    }

    private async handleCreateExam(): Promise<void> {
        if (this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.examPhase = "generating";
        this.examSession = null;
        this.render();

        try {
            const selectedFolderPaths: string[] = this.getSelectedExamFolderPaths();
            const session: ExamSession = await this.plugin.createExamSession(
                selectedFolderPaths,
                this.examQuestionCount,
            );
            this.examSession = session;
            this.examPhase = "taking";
        } catch (error: unknown) {
            console.error("[VaultCoachView] 创建考试失败", error);
            this.examPhase = "setup";
            new Notice(this.t("exam.notice.createFailed", { message: this.createShortErrorMessage(error) }));
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

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

    private getSelectedExamFolderPaths(): string[] {
        if (this.selectedExamScopeIds.has("__all__")) {
            return [];
        }

        const selectedFolderPaths: string[] = [];
        for (const option of this.plugin.getExamScopeOptions()) {
            if (option.folderPath && this.selectedExamScopeIds.has(option.id)) {
                selectedFolderPaths.push(option.folderPath);
            }
        }

        return selectedFolderPaths;
    }

    private hasExamScopeSelection(scopeOptions: ExamScopeOption[]): boolean {
        if (this.selectedExamScopeIds.has("__all__")) {
            return true;
        }

        return scopeOptions.some((option: ExamScopeOption) => {
            return option.folderPath !== null && this.selectedExamScopeIds.has(option.id);
        });
    }

    private normalizeQuestionCount(value: string): number {
        const parsedValue: number = Number.parseInt(value, 10);
        if (!Number.isFinite(parsedValue)) {
            return 5;
        }

        return Math.max(1, Math.min(10, parsedValue));
    }

    private resetExamSession(): void {
        this.examSession = null;
        this.examPhase = "setup";
        this.examAnswerEls = [];
    }

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

    private normalizeExamSourcePath(sourcePath: string): string {
        return sourcePath
            .trim()
            .replace(/^obsidian:\/\/open\?/i, "")
            .replace(/^#/, "")
            .replace(/^\[\[/, "")
            .replace(/\]\]$/, "")
            .trim();
    }

    private getExamScoreClass(score: number): string {
        if (score >= 85) {
            return "is-good";
        }

        if (score >= 60) {
            return "is-medium";
        }

        return "is-low";
    }

    private formatExamHistoryMeta(item: ExamHistoryItem): string {
        const dateText: string = item.createdAt
            ? this.formatDateTime(item.createdAt)
            : this.t("exam.history.unknownDate");
        const scoreText: string = item.score !== null && item.maxScore !== null
            ? `${item.score} / ${item.maxScore}`
            : this.t("exam.history.noScore");

        return `${dateText} · ${scoreText}`;
    }


    // 处理发送逻辑
    private async handleSend(): Promise<void> {
        const userText: string = this.inputEl.value.trim();

        // 用户什么都没输入，就不发送
        if (!userText || this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.activeAbortController = new AbortController();
        this.sendButtonEl.disabled = true;
        this.stopButtonEl.disabled = false;
        this.inputEl.disabled = true;
        this.retrievalModeSelectEl.disabled = true;

        try {
            // 1. 将用户消息加入对话
            // this.plugin.addUserMessage(userText);

            // 2.  清空输入框
            this.inputEl.value = "";
            await this.plugin.appendUserMessage(userText);

            // 3. 立刻刷新消息区域，让用户先看到自己的消息
            await this.renderMessages();

            this.beginStreamingAssistantBubble();

            // 4. 生成助手回复 
            // TODO 目前还只是展示逻辑，后续再接入本地 LLM
            // const answer = await this.plugin.answerQuestion(userText);

            // 5. 把助手回复加入对话
            // this.plugin.addAssistantMessage(answer.text, answer.sources);

            await this.plugin.streamAssistantTurn(userText, {
                onToken: (token: string) => {
                    this.appendStreamingToken(token);
                },
                abortSignal: this.activeAbortController.signal,
            });

            if (this.activeAbortController.signal.aborted) {
                new Notice(this.t("view.generationStopped"));
            }

            this.clearStreamingAssistantBubble();

            // 6. 再次刷新消息区域
            await this.renderMessages();

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
            // 7. 把焦点重新放回输入框
            this.focusInput();
        }
    }

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
     * 手动重建索引
     */
    private async handleRebuildIndex(): Promise<void> {
        if (this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.sendButtonEl?.setAttribute("disabled", "true");
        this.retrievalModeSelectEl?.setAttribute("disabled", "true");

        try {
            await this.plugin.rebuildKnowledgeBase(true);
        } finally {
            this.isBusy = false;
            this.sendButtonEl?.removeAttribute("disabled");
            this.retrievalModeSelectEl?.removeAttribute("disabled");
            if (this.activeInteractionMode === "qa") {
                this.focusInput();
            }
        }
    }

    /**
     * 聚焦输入框
     *  */ 
    private focusInput(): void {
        this.inputEl?.focus();
    }

    private scrollMessagesToBottom(): void {
        this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
    }

    /**
     * 格式化时间
     */
    private formatTime(timestamp: number): string {
        return new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    private formatDateTime(timestamp: number): string {
        return new Date(timestamp).toLocaleString([], {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    private createShortErrorMessage(error: unknown): string {
        const message: string = error instanceof Error ? error.message : String(error);
        const normalizedMessage: string = message.replace(/\s+/g, " ").trim();

        if (normalizedMessage.length <= 180) {
            return normalizedMessage;
        }

        return `${normalizedMessage.slice(0, 177)}...`;
    }

}
