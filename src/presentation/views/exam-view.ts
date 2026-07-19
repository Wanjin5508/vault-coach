import { MarkdownRenderer, Notice, type App, type Component } from "obsidian";
import { createShortErrorMessage, formatDateTime } from "../../ui/view-formatters";
import { translate, type TranslationKey } from "../../i18n";
import type {
    ExamContentProfile,
    ExamFileOption,
    ExamHistoryItem,
    ExamQuestion,
    ExamScopeAnalysisResult,
    ExamScopeOption,
    ExamScopeSnapshot,
    ExamSession,
} from "../../domain/exam/exam-types";
import { ExamController, type ExamViewState } from "../controllers/exam-controller";

/** Renders the exam interface and delegates every state change to ExamController. */
export class ExamView {
    private answerEls: HTMLTextAreaElement[] = [];

    constructor(
        private readonly app: App,
        private readonly component: Component,
        private readonly controller: ExamController,
    ) {}

    render(rootEl: HTMLDivElement): void {
        this.answerEls = [];
        const examAreaEl = rootEl.createDiv({ cls: "vault-coach-exam-area" });
        const state = this.controller.getState();

        if (state.phase === "history") {
            this.renderHistory(examAreaEl, state);
            return;
        }
        if (state.phase === "generating") {
            this.renderBusyState(examAreaEl, state.progressLabel || this.t("exam.generating"), true);
            return;
        }
        if (state.phase === "evaluating") {
            this.renderBusyState(examAreaEl, this.t("exam.evaluating"));
            return;
        }
        if (!state.session) {
            this.renderSetup(examAreaEl, state);
            return;
        }
        if (state.phase === "taking" || state.session.status === "draft") {
            this.renderTaking(examAreaEl, state, state.session);
            return;
        }
        this.renderReview(examAreaEl, state, state.session);
    }

    dispose(): void {
        this.answerEls = [];
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    private renderSetup(containerEl: HTMLDivElement, state: Readonly<ExamViewState>): void {
        const panelEl = containerEl.createDiv({ cls: "vault-coach-exam-panel" });
        panelEl.createEl("h4", { text: this.t("exam.setup.title") });
        panelEl.createEl("p", { text: this.t("exam.setup.desc"), cls: "vault-coach-exam-description" });

        const scopeOptions = this.controller.getScopeOptions();
        const allScopeOption = scopeOptions[0];
        if (!allScopeOption || allScopeOption.chunkCount === 0) {
            const emptyEl = panelEl.createDiv({ cls: "vault-coach-exam-empty" });
            emptyEl.createDiv({ cls: "vault-coach-exam-empty-title", text: this.t("exam.emptyKnowledge.title") });
            emptyEl.createDiv({ cls: "vault-coach-exam-empty-description", text: this.t("exam.emptyKnowledge.desc") });
            const historyButtonEl = emptyEl.createEl("button", { text: this.t("exam.history") });
            historyButtonEl.disabled = state.busy;
            historyButtonEl.addEventListener("click", () => void this.controller.showHistory());
            return;
        }

        const scopeSectionEl = panelEl.createDiv({ cls: "vault-coach-exam-section" });
        scopeSectionEl.createDiv({ cls: "vault-coach-exam-section-title", text: this.t("exam.scope.title") });
        const scopeListEl = scopeSectionEl.createDiv({ cls: "vault-coach-exam-scope-list" });
        this.renderScopeOption(scopeListEl, state, allScopeOption, true);

        const fileOptions = this.controller.getFileOptions(scopeOptions);
        const scopeSnapshot = this.controller.getScopeSnapshot(scopeOptions);
        this.renderFileScopeSection(panelEl, state, fileOptions, scopeSnapshot);
        if (state.smartFilteringFailed) {
            this.renderSmartFilteringFailure(panelEl, state);
        }
        if (state.analysis) {
            this.renderAnalysisPreview(panelEl, state, fileOptions, state.analysis);
        }

        const folderOptions = scopeOptions.slice(1);
        if (folderOptions.length === 0) {
            scopeListEl.createDiv({ cls: "vault-coach-exam-muted", text: this.t("exam.scope.noFolders") });
        } else {
            scopeListEl.createDiv({ cls: "vault-coach-exam-subtitle", text: this.t("exam.scope.folders") });
            for (const option of folderOptions) {
                this.renderScopeOption(scopeListEl, state, option, false);
            }
        }

        const maxQuestionCount = scopeSnapshot.estimatedMaxQuestions;
        if (maxQuestionCount > 0 && state.questionCount > maxQuestionCount) {
            this.controller.setQuestionCount(String(maxQuestionCount), maxQuestionCount);
            return;
        }
        const countSectionEl = panelEl.createDiv({ cls: "vault-coach-exam-section vault-coach-exam-count-row" });
        countSectionEl.createSpan({ text: this.t("exam.questionCount") });
        const countInputEl = countSectionEl.createEl("input");
        countInputEl.type = "number";
        countInputEl.min = "1";
        countInputEl.max = String(Math.max(1, maxQuestionCount || 10));
        countInputEl.step = "1";
        countInputEl.value = String(state.questionCount);
        countInputEl.addEventListener("change", () => {
            this.controller.setQuestionCount(countInputEl.value, maxQuestionCount);
        });

        const actionRowEl = panelEl.createDiv({ cls: "vault-coach-exam-actions" });
        const smartFilteringEnabled = this.controller.isSmartFilteringEnabled();
        const startButtonEl = actionRowEl.createEl("button", {
            text: smartFilteringEnabled && !state.analysis ? this.t("exam.analyze") : this.t("exam.start"),
            cls: "mod-cta",
        });
        startButtonEl.disabled = state.busy || !this.controller.hasScopeSelection(scopeOptions) || scopeSnapshot.eligibleChunkCount === 0;
        startButtonEl.addEventListener("click", () => {
            if (smartFilteringEnabled && !state.analysis) {
                void this.controller.analyzeScope(false);
                return;
            }
            void this.controller.createExam(false);
        });

        if (state.analysis) {
            const reanalyzeButtonEl = actionRowEl.createEl("button", { text: this.t("exam.reanalyze") });
            reanalyzeButtonEl.disabled = state.busy;
            reanalyzeButtonEl.addEventListener("click", () => void this.controller.analyzeScope(true));
        }
        const historyButtonEl = actionRowEl.createEl("button", { text: this.t("exam.history") });
        historyButtonEl.disabled = state.busy;
        historyButtonEl.addEventListener("click", () => void this.controller.showHistory());
    }

    private renderScopeOption(
        containerEl: HTMLDivElement,
        state: Readonly<ExamViewState>,
        option: ExamScopeOption,
        isAllOption: boolean,
    ): void {
        const optionEl = containerEl.createEl("label", { cls: "vault-coach-exam-scope-option" });
        const checkboxEl = optionEl.createEl("input");
        checkboxEl.type = "checkbox";
        checkboxEl.checked = isAllOption ? state.selectedScopeIds.has("__all__") : state.selectedScopeIds.has(option.id);
        if (checkboxEl.checked) {
            optionEl.addClass("is-selected");
        }
        const textEl = optionEl.createSpan({ cls: "vault-coach-exam-scope-text" });
        textEl.createSpan({ cls: "vault-coach-exam-scope-label", text: isAllOption ? this.t("exam.scope.all") : option.label });
        textEl.createSpan({
            cls: "vault-coach-exam-scope-meta",
            text: this.t("exam.scope.meta", { fileCount: option.fileCount, chunkCount: option.chunkCount }),
        });
        checkboxEl.addEventListener("change", () => this.controller.toggleScope(option, isAllOption, checkboxEl.checked));
    }

    private renderFileScopeSection(
        containerEl: HTMLDivElement,
        state: Readonly<ExamViewState>,
        fileOptions: ExamFileOption[],
        scopeSnapshot: ExamScopeSnapshot,
    ): void {
        const fileSectionEl = containerEl.createDiv({ cls: "vault-coach-exam-section" });
        fileSectionEl.createDiv({ cls: "vault-coach-exam-section-title", text: this.t("exam.files.title") });
        this.renderSmartFilteringToggle(fileSectionEl, state);

        const summaryEl = fileSectionEl.createDiv({ cls: "vault-coach-exam-file-summary" });
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
                ? this.t("exam.files.capacity", { min: scopeSnapshot.estimatedMinQuestions, max: scopeSnapshot.estimatedMaxQuestions })
                : this.t("exam.files.capacityEmpty"),
        });
        const manageButtonEl = summaryEl.createEl("button", {
            text: state.showFileManager ? this.t("exam.files.hideManager") : this.t("exam.files.manage"),
        });
        manageButtonEl.disabled = state.busy || fileOptions.length === 0;
        manageButtonEl.addEventListener("click", () => this.controller.setFileManagerVisible(!state.showFileManager));

        if (scopeSnapshot.eligibleChunkCount === 0) {
            fileSectionEl.createDiv({ cls: "vault-coach-exam-warning", text: this.t("exam.files.noEligible") });
        }
        if (state.showFileManager) {
            this.renderFileManager(fileSectionEl, state, fileOptions);
        }
    }

    private renderSmartFilteringToggle(containerEl: HTMLDivElement, state: Readonly<ExamViewState>): void {
        const toggleLabelEl = containerEl.createEl("label", { cls: "vault-coach-exam-toggle" });
        const checkboxEl = toggleLabelEl.createEl("input");
        checkboxEl.type = "checkbox";
        checkboxEl.checked = this.controller.isSmartFilteringEnabled();
        checkboxEl.disabled = state.busy;
        const textEl = toggleLabelEl.createSpan({ cls: "vault-coach-exam-toggle-text" });
        textEl.createSpan({ cls: "vault-coach-exam-toggle-title", text: this.t("settings.examSmartFiltering.name") });
        textEl.createSpan({ cls: "vault-coach-exam-toggle-description", text: this.t("settings.examSmartFiltering.desc") });
        checkboxEl.addEventListener("change", () => void this.controller.setSmartFilteringEnabled(checkboxEl.checked));
    }

    private renderFileManager(
        containerEl: HTMLDivElement,
        state: Readonly<ExamViewState>,
        fileOptions: ExamFileOption[],
    ): void {
        const managerEl = containerEl.createDiv({ cls: "vault-coach-exam-file-manager" });
        const toolbarEl = managerEl.createDiv({ cls: "vault-coach-exam-file-toolbar" });
        const searchInputEl = toolbarEl.createEl("input", { attr: { type: "search", placeholder: this.t("exam.files.search") } });
        searchInputEl.value = state.fileSearchText;
        searchInputEl.addEventListener("input", () => this.controller.setFileSearchText(searchInputEl.value));

        const includeAllButtonEl = toolbarEl.createEl("button", { text: this.t("exam.files.includeAll") });
        includeAllButtonEl.disabled = state.busy;
        includeAllButtonEl.addEventListener("click", () => this.controller.includeAllFiles(fileOptions));
        const excludeAllButtonEl = toolbarEl.createEl("button", { text: this.t("exam.files.excludeAll") });
        excludeAllButtonEl.disabled = state.busy;
        excludeAllButtonEl.addEventListener("click", () => this.controller.excludeAllFiles(fileOptions));
        const resetButtonEl = toolbarEl.createEl("button", { text: this.t("exam.files.reset") });
        resetButtonEl.disabled = state.busy;
        resetButtonEl.addEventListener("click", () => this.controller.resetFileSelection(fileOptions));

        const searchText = state.fileSearchText.trim().toLowerCase();
        const visibleOptions = searchText.length === 0 ? fileOptions : fileOptions.filter((option) => option.filePath.toLowerCase().includes(searchText));
        if (visibleOptions.length === 0) {
            managerEl.createDiv({ cls: "vault-coach-exam-muted", text: this.t("exam.files.noMatches") });
            return;
        }
        const groupedOptions = new Map<string, ExamFileOption[]>();
        for (const option of visibleOptions) {
            const folderLabel = option.parentFolder.length > 0 ? option.parentFolder : this.t("exam.files.rootFolder");
            const group = groupedOptions.get(folderLabel) ?? [];
            group.push(option);
            groupedOptions.set(folderLabel, group);
        }
        const listEl = managerEl.createDiv({ cls: "vault-coach-exam-file-list" });
        for (const [folderLabel, options] of groupedOptions) {
            const folderDetailsEl = listEl.createEl("details", { cls: "vault-coach-exam-file-folder", attr: { open: "true" } });
            folderDetailsEl.createEl("summary", { text: `${folderLabel} (${options.length})`, cls: "vault-coach-exam-file-folder-title" });
            for (const option of options) {
                this.renderFileOption(folderDetailsEl, state, option);
            }
        }
    }

    private renderFileOption(containerEl: HTMLElement, state: Readonly<ExamViewState>, option: ExamFileOption): void {
        const optionEl = containerEl.createEl("label", {
            cls: `vault-coach-exam-file-option ${option.permanentlyExcluded ? "is-permanently-excluded" : ""}`,
        });
        const checkboxEl = optionEl.createEl("input");
        checkboxEl.type = "checkbox";
        checkboxEl.disabled = option.permanentlyExcluded || state.busy;
        checkboxEl.checked = !option.permanentlyExcluded && !state.excludedFilePaths.has(option.filePath);
        checkboxEl.addEventListener("change", () => this.controller.setFileExcluded(option, !checkboxEl.checked));
        const bodyEl = optionEl.createDiv({ cls: "vault-coach-exam-file-option-body" });
        bodyEl.createDiv({ cls: "vault-coach-exam-file-name", text: option.fileName });
        bodyEl.createDiv({ cls: "vault-coach-exam-file-path", text: option.filePath });
        const metaEl = bodyEl.createDiv({ cls: "vault-coach-exam-file-meta" });
        metaEl.createSpan({ cls: "vault-coach-exam-file-badge", text: this.t("exam.files.chunkCount", { count: option.chunkCount }) });
        if (option.permanentlyExcluded) {
            metaEl.createSpan({
                cls: "vault-coach-exam-file-badge is-muted",
                text: option.permanentExcludeReason
                    ? this.t("exam.files.permanentReason", { reason: option.permanentExcludeReason })
                    : this.t("exam.files.permanentExcluded"),
            });
        } else if (state.excludedFilePaths.has(option.filePath)) {
            metaEl.createSpan({ cls: "vault-coach-exam-file-badge is-muted", text: this.t("exam.files.manualExcluded") });
        }
    }

    private renderSmartFilteringFailure(containerEl: HTMLDivElement, state: Readonly<ExamViewState>): void {
        const warningEl = containerEl.createDiv({ cls: "vault-coach-exam-analysis-warning" });
        warningEl.createDiv({ cls: "vault-coach-exam-analysis-title", text: this.t("exam.analysis.failedTitle") });
        warningEl.createDiv({ cls: "vault-coach-exam-analysis-text", text: this.t("exam.analysis.failedDesc") });
        const actionRowEl = warningEl.createDiv({ cls: "vault-coach-exam-analysis-actions" });
        const retryButtonEl = actionRowEl.createEl("button", { text: this.t("exam.analysis.retry") });
        retryButtonEl.disabled = state.busy;
        retryButtonEl.addEventListener("click", () => void this.controller.analyzeScope(false));
        const manualButtonEl = actionRowEl.createEl("button", { text: this.t("exam.analysis.continueManual") });
        manualButtonEl.disabled = state.busy;
        manualButtonEl.addEventListener("click", () => void this.controller.createExam(true));
    }

    private renderAnalysisPreview(
        containerEl: HTMLDivElement,
        state: Readonly<ExamViewState>,
        fileOptions: ExamFileOption[],
        analysis: ExamScopeAnalysisResult,
    ): void {
        const previewEl = containerEl.createDiv({ cls: "vault-coach-exam-analysis" });
        previewEl.createDiv({ cls: "vault-coach-exam-analysis-title", text: this.t("exam.analysis.complete") });
        const summaryEl = previewEl.createDiv({ cls: "vault-coach-exam-analysis-grid" });
        const summary = analysis.summary;
        this.renderAnalysisStat(summaryEl, this.t("exam.analysis.totalFiles"), summary.totalFiles);
        this.renderAnalysisStat(summaryEl, this.t("exam.analysis.ruleExcluded"), summary.ruleExcludedFiles);
        this.renderAnalysisStat(summaryEl, this.t("exam.analysis.semanticExcluded"), summary.semanticExcludedFiles);
        this.renderAnalysisStat(summaryEl, this.t("exam.analysis.partial"), summary.partialFiles);
        this.renderAnalysisStat(summaryEl, this.t("exam.analysis.included"), summary.includedFiles);
        this.renderAnalysisStat(summaryEl, this.t("exam.analysis.capacity"), `${summary.estimatedMinQuestions}–${summary.estimatedMaxQuestions}`);
        this.renderAnalysisStat(summaryEl, this.t("exam.analysis.cache"), `${summary.cacheHits}/${summary.cacheHits + summary.cacheMisses}`);

        const detailsEl = previewEl.createEl("details", { cls: "vault-coach-exam-analysis-details" });
        detailsEl.createEl("summary", { text: this.t("exam.analysis.details") });
        const profileByPath = new Map<string, ExamContentProfile>(analysis.profiles.map((profile) => [profile.filePath, profile]));
        for (const option of fileOptions) {
            const profile = profileByPath.get(option.filePath);
            const rowEl = detailsEl.createDiv({ cls: "vault-coach-exam-analysis-row" });
            const mainEl = rowEl.createDiv({ cls: "vault-coach-exam-analysis-file" });
            const fileLinkButtonEl = mainEl.createEl("button", {
                cls: "vault-coach-exam-file-link",
                text: option.fileName,
                attr: { type: "button", title: option.filePath },
            });
            fileLinkButtonEl.addEventListener("click", () => void this.openSourcePath(option.filePath));
            mainEl.createDiv({ cls: "vault-coach-exam-file-path", text: option.filePath });
            const statusEl = rowEl.createDiv({ cls: "vault-coach-exam-analysis-status" });
            statusEl.createSpan({
                cls: `vault-coach-exam-file-badge ${this.getAnalysisDecisionClass(state, option, profile)}`,
                text: this.getAnalysisDecisionLabel(state, option, profile),
            });
            const reasonText = this.getAnalysisReasonText(option, profile);
            if (reasonText.length > 0) {
                statusEl.createSpan({ cls: "vault-coach-exam-file-badge is-muted", text: reasonText });
            }
            const actionEl = rowEl.createDiv({ cls: "vault-coach-exam-analysis-actions" });
            if (!option.permanentlyExcluded && !state.excludedFilePaths.has(option.filePath)) {
                const excludeButtonEl = actionEl.createEl("button", { text: this.t("exam.analysis.exclude") });
                excludeButtonEl.disabled = state.busy;
                excludeButtonEl.addEventListener("click", () => {
                    this.controller.setFileExcluded(option, true);
                    void this.controller.analyzeScope(false);
                });
            }
            if (profile && !option.permanentlyExcluded && !state.forceIncludedFilePaths.has(option.filePath)
                && (profile.decision === "exclude" || profile.decision === "partial")) {
                const includeButtonEl = actionEl.createEl("button", { text: this.t("exam.analysis.forceInclude") });
                includeButtonEl.disabled = state.busy;
                includeButtonEl.addEventListener("click", () => {
                    this.controller.forceIncludeFile(option);
                    void this.controller.analyzeScope(false);
                });
            }
        }
    }

    private renderAnalysisStat(containerEl: HTMLDivElement, label: string, value: string | number): void {
        const itemEl = containerEl.createDiv({ cls: "vault-coach-exam-analysis-stat" });
        itemEl.createDiv({ cls: "vault-coach-exam-analysis-stat-value", text: String(value) });
        itemEl.createDiv({ cls: "vault-coach-exam-analysis-stat-label", text: label });
    }

    private getAnalysisDecisionLabel(
        state: Readonly<ExamViewState>,
        option: ExamFileOption,
        profile: ExamContentProfile | undefined,
    ): string {
        if (option.permanentlyExcluded) return this.t("exam.analysis.ruleExcluded");
        if (state.excludedFilePaths.has(option.filePath)) return this.t("exam.files.manualExcluded");
        if (state.forceIncludedFilePaths.has(option.filePath)) return this.t("exam.analysis.forceIncluded");
        if (profile?.decision === "exclude") return this.t("exam.analysis.semanticExcluded");
        if (profile?.decision === "partial") return this.t("exam.analysis.partial");
        return this.t("exam.analysis.included");
    }

    private getAnalysisDecisionClass(
        state: Readonly<ExamViewState>,
        option: ExamFileOption,
        profile: ExamContentProfile | undefined,
    ): string {
        if (option.permanentlyExcluded || state.excludedFilePaths.has(option.filePath) || profile?.decision === "exclude") return "is-muted";
        return profile?.decision === "partial" ? "is-warning" : "is-positive";
    }

    private getAnalysisReasonText(option: ExamFileOption, profile: ExamContentProfile | undefined): string {
        if (option.permanentExcludeReason) return option.permanentExcludeReason;
        return profile?.reasonCodes.join(", ") ?? "";
    }

    private renderBusyState(containerEl: HTMLDivElement, label: string, canCancel = false): void {
        const panelEl = containerEl.createDiv({ cls: "vault-coach-exam-panel vault-coach-exam-busy" });
        const thinkingEl = panelEl.createDiv({ cls: "vault-coach-thinking-indicator" });
        thinkingEl.createSpan({ cls: "vault-coach-thinking-spinner", attr: { "aria-hidden": "true" } });
        thinkingEl.createSpan({ cls: "vault-coach-thinking-text", text: label });
        const dotsEl = thinkingEl.createSpan({ cls: "vault-coach-thinking-dots", attr: { "aria-hidden": "true" } });
        for (let index = 0; index < 3; index += 1) dotsEl.createSpan({ cls: "vault-coach-thinking-dot", text: "." });
        if (canCancel) {
            const cancelButtonEl = panelEl.createEl("button", { text: this.t("exam.cancel") });
            cancelButtonEl.addEventListener("click", () => this.controller.cancelActiveOperation());
        }
    }

    private renderTaking(containerEl: HTMLDivElement, state: Readonly<ExamViewState>, session: ExamSession): void {
        const panelEl = containerEl.createDiv({ cls: "vault-coach-exam-panel" });
        const titleRowEl = panelEl.createDiv({ cls: "vault-coach-exam-title-row" });
        titleRowEl.createEl("h4", { text: session.title });
        titleRowEl.createSpan({ cls: "vault-coach-exam-badge", text: session.scopeLabel });
        panelEl.createEl("p", { text: this.t("exam.taking.desc"), cls: "vault-coach-exam-description" });
        session.questions.forEach((question, index) => {
            const questionEl = panelEl.createDiv({ cls: "vault-coach-exam-question" });
            questionEl.createDiv({ cls: "vault-coach-exam-question-title", text: `${index + 1}. ${question.question}` });
            const answerEl = questionEl.createEl("textarea", {
                cls: "vault-coach-exam-answer-input",
                attr: { placeholder: this.t("exam.answerPlaceholder"), rows: "5" },
            });
            answerEl.value = session.userAnswers[index] ?? "";
            answerEl.disabled = state.busy;
            answerEl.addEventListener("input", () => this.controller.setAnswer(index, answerEl.value));
            this.answerEls.push(answerEl);
        });
        const actionRowEl = panelEl.createDiv({ cls: "vault-coach-exam-actions" });
        const submitButtonEl = actionRowEl.createEl("button", { text: this.t("exam.submit"), cls: "mod-cta" });
        submitButtonEl.disabled = state.busy;
        submitButtonEl.addEventListener("click", () => void this.controller.submitAnswers(this.answerEls.map((answerEl) => answerEl.value)));
        const deleteButtonEl = actionRowEl.createEl("button", { text: this.t("exam.delete") });
        deleteButtonEl.disabled = state.busy;
        deleteButtonEl.addEventListener("click", () => void this.controller.deleteSession());
    }

    private renderReview(containerEl: HTMLDivElement, state: Readonly<ExamViewState>, session: ExamSession): void {
        const evaluation = session.evaluation;
        if (!evaluation) {
            this.renderTaking(containerEl, state, session);
            return;
        }
        const panelEl = containerEl.createDiv({ cls: "vault-coach-exam-panel" });
        const titleRowEl = panelEl.createDiv({ cls: "vault-coach-exam-title-row" });
        titleRowEl.createEl("h4", { text: this.t("exam.review.title") });
        titleRowEl.createSpan({ cls: "vault-coach-exam-badge", text: session.title });
        const scoreEl = panelEl.createDiv({ cls: "vault-coach-exam-score-card" });
        scoreEl.createDiv({ cls: "vault-coach-exam-score-value", text: `${evaluation.score} / ${evaluation.maxScore}` });
        scoreEl.createDiv({ cls: "vault-coach-exam-score-label", text: this.t("exam.score") });
        this.renderReviewBlock(panelEl, this.t("exam.overallFeedback"), evaluation.overallFeedback);
        session.questions.forEach((question, index) => this.renderReviewQuestion(panelEl, session, question, index));
        if (session.savedPath) panelEl.createDiv({ cls: "vault-coach-exam-saved-path", text: this.t("exam.savedPath", { path: session.savedPath }) });

        const exportEl = panelEl.createDiv({ cls: "vault-coach-exam-export" });
        exportEl.createDiv({ cls: "vault-coach-exam-section-title", text: this.t("exam.export.title") });
        exportEl.createDiv({ cls: "vault-coach-exam-description", text: this.t("exam.export.desc") });
        const exportRowEl = exportEl.createDiv({ cls: "vault-coach-exam-export-row" });
        const exportInputEl = exportRowEl.createEl("input", { attr: { type: "text", placeholder: this.t("exam.export.placeholder") } });
        exportInputEl.value = state.exportFolderPath;
        exportInputEl.disabled = state.busy;
        exportInputEl.addEventListener("input", () => this.controller.setExportFolderPath(exportInputEl.value));
        const exportButtonEl = exportRowEl.createEl("button", { text: this.t("exam.export.button") });
        exportButtonEl.disabled = state.busy;
        exportButtonEl.addEventListener("click", () => void this.controller.exportSession());

        const actionRowEl = panelEl.createDiv({ cls: "vault-coach-exam-actions" });
        const historyButtonEl = actionRowEl.createEl("button", { text: this.t("exam.history") });
        historyButtonEl.disabled = state.busy;
        historyButtonEl.addEventListener("click", () => void this.controller.showHistory());
        const deleteButtonEl = actionRowEl.createEl("button", { text: this.t("exam.delete") });
        deleteButtonEl.disabled = state.busy;
        deleteButtonEl.addEventListener("click", () => void this.controller.deleteSession());
        const newButtonEl = actionRowEl.createEl("button", { text: this.t("exam.newTest") });
        newButtonEl.disabled = state.busy;
        newButtonEl.addEventListener("click", () => this.controller.resetSession());
    }

    private renderReviewQuestion(containerEl: HTMLDivElement, session: ExamSession, question: ExamQuestion, index: number): void {
        const item = session.evaluation?.items.find((evaluationItem) => evaluationItem.questionId === question.id);
        const questionEl = containerEl.createDiv({ cls: "vault-coach-exam-question vault-coach-exam-question-review" });
        questionEl.createDiv({ cls: "vault-coach-exam-question-title", text: `${index + 1}. ${question.question}` });
        if (item) {
            questionEl.createDiv({
                cls: `vault-coach-exam-question-score ${this.getScoreClass(item.score)}`,
                text: `${this.t("exam.score")}: ${item.score} / ${item.maxScore}`,
            });
        }
        this.renderReviewBlock(questionEl, this.t("exam.userAnswer"), session.userAnswers[index]?.trim() || this.t("exam.unanswered"));
        this.renderReviewBlock(questionEl, this.t("exam.referenceAnswer"), question.referenceAnswer);
        this.renderReviewBlock(questionEl, this.t("exam.rubric"), question.rubric);
        if (item) {
            this.renderReviewBlock(questionEl, this.t("exam.feedback"), item.feedback);
            this.renderReviewBlock(questionEl, this.t("exam.improvement"), item.improvement);
        }
        if (question.sourcePaths.length > 0) {
            const sourceEl = questionEl.createDiv({ cls: "vault-coach-exam-review-block" });
            sourceEl.createEl("strong", { cls: "vault-coach-exam-review-label", text: this.t("exam.sourcePaths") });
            const listEl = sourceEl.createEl("ul", { cls: "vault-coach-exam-source-list" });
            for (const sourcePath of question.sourcePaths) {
                const itemEl = listEl.createEl("li");
                const sourceButtonEl = itemEl.createEl("button", { cls: "vault-coach-exam-source-link", text: sourcePath });
                sourceButtonEl.addEventListener("click", () => void this.openSourcePath(sourcePath));
            }
        }
    }

    private renderHistory(containerEl: HTMLDivElement, state: Readonly<ExamViewState>): void {
        const panelEl = containerEl.createDiv({ cls: "vault-coach-exam-panel" });
        const titleRowEl = panelEl.createDiv({ cls: "vault-coach-exam-title-row" });
        titleRowEl.createEl("h4", { text: this.t("exam.history.title") });
        const backButtonEl = titleRowEl.createEl("button", { text: this.t("exam.history.back") });
        backButtonEl.addEventListener("click", () => this.controller.returnFromHistory());
        if (state.busy) {
            this.renderBusyState(panelEl, this.t("exam.history.loading"));
            return;
        }
        if (state.historyItems.length === 0) {
            panelEl.createDiv({ cls: "vault-coach-exam-empty-description", text: this.t("exam.history.empty") });
            return;
        }
        const historyLayoutEl = panelEl.createDiv({ cls: "vault-coach-exam-history-layout" });
        const listEl = historyLayoutEl.createDiv({ cls: "vault-coach-exam-history-list" });
        for (const item of state.historyItems) {
            const itemEl = listEl.createDiv({ cls: `vault-coach-exam-history-item ${item.path === state.selectedHistoryPath ? "is-selected" : ""}` });
            const buttonEl = itemEl.createEl("button", { cls: "vault-coach-exam-history-main" });
            buttonEl.createSpan({ cls: "vault-coach-exam-history-title", text: item.title });
            buttonEl.createSpan({ cls: "vault-coach-exam-history-meta", text: this.formatHistoryMeta(item) });
            buttonEl.addEventListener("click", () => void this.controller.loadHistory(item.path));
            const deleteButtonEl = itemEl.createEl("button", { cls: "vault-coach-exam-history-delete", text: this.t("exam.history.delete") });
            deleteButtonEl.addEventListener("click", () => void this.controller.deleteHistory(item.path));
        }
        const detailEl = historyLayoutEl.createDiv({ cls: "vault-coach-exam-history-detail markdown-rendered" });
        if (state.selectedHistoryContent.length === 0) {
            detailEl.createDiv({ cls: "vault-coach-exam-muted", text: this.t("exam.history.select") });
            return;
        }
        void this.renderHistoryMarkdown(detailEl, state.selectedHistoryContent);
    }

    private async renderHistoryMarkdown(containerEl: HTMLElement, markdown: string): Promise<void> {
        containerEl.empty();
        try {
            await MarkdownRenderer.render(this.app, markdown, containerEl, "", this.component);
            this.bindHistoryInternalLinks(containerEl);
        } catch (error: unknown) {
            console.error("[VaultCoachExamView] 考试历史 Markdown 渲染失败", error);
            containerEl.setText(markdown);
        }
    }

    private bindHistoryInternalLinks(containerEl: HTMLElement): void {
        containerEl.addEventListener("click", (event: MouseEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            const linkEl = target?.closest(".internal-link") ?? null;
            if (!linkEl) return;
            const targetPath = linkEl.getAttribute("data-href") ?? linkEl.getAttribute("href") ?? linkEl.textContent ?? "";
            if (this.normalizeSourcePath(targetPath).length === 0) return;
            event.preventDefault();
            event.stopPropagation();
            void this.openSourcePath(targetPath);
        });
    }

    private renderReviewBlock(containerEl: HTMLElement, label: string, text: string): void {
        const blockEl = containerEl.createDiv({ cls: "vault-coach-exam-review-block" });
        blockEl.createEl("strong", { cls: "vault-coach-exam-review-label", text: label });
        blockEl.createDiv({ cls: "vault-coach-exam-review-text", text });
    }

    private getScoreClass(score: number): string {
        if (score >= 85) return "is-good";
        return score >= 60 ? "is-medium" : "is-low";
    }

    private formatHistoryMeta(item: ExamHistoryItem): string {
        const dateText = item.createdAt ? formatDateTime(item.createdAt) : this.t("exam.history.unknownDate");
        const scoreText = item.score !== null && item.maxScore !== null
            ? `${item.score} / ${item.maxScore}`
            : this.t("exam.history.noScore");
        return `${dateText} · ${scoreText}`;
    }

    private async openSourcePath(sourcePath: string): Promise<void> {
        const normalizedSourcePath = this.normalizeSourcePath(sourcePath);
        if (!normalizedSourcePath) return;
        try {
            const activeFilePath = this.app.workspace.getActiveFile()?.path ?? "";
            await this.app.workspace.openLinkText(normalizedSourcePath, activeFilePath, false);
        } catch (error: unknown) {
            console.error("[VaultCoachExamView] 打开考试来源失败", error);
            new Notice(this.t("exam.notice.openSourceFailed", { message: createShortErrorMessage(error) }));
        }
    }

    private normalizeSourcePath(sourcePath: string): string {
        return sourcePath.trim().replace(/^obsidian:\/\/open\?/i, "").replace(/^#/, "").replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
    }
}
