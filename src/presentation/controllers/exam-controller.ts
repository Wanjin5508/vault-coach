import { isAbortError } from "../../utils/errors";
import type {
    ExamFileOption,
    ExamGenerationOptions,
    ExamGenerationProgress,
    ExamHistoryItem,
    ExamMode,
    ExamScopeAnalysisResult,
    ExamScopeOption,
    ExamScopeSelection,
    ExamScopeSnapshot,
    ExamSession,
} from "../../domain/exam/exam-types";
import type { TranslationKey } from "../../i18n";
import type { VaultCoachPluginApi } from "../plugin-api";

export type ExamViewPhase = "setup" | "generating" | "taking" | "evaluating" | "review" | "history";

export interface ExamViewState {
    phase: ExamViewPhase;
    session: ExamSession | null;
    selectedScopeIds: ReadonlySet<string>;
    excludedFilePaths: ReadonlySet<string>;
    forceIncludedFilePaths: ReadonlySet<string>;
    showFileManager: boolean;
    fileSearchText: string;
    analysis: ExamScopeAnalysisResult | null;
    smartFilteringFailed: boolean;
    progressLabel: string;
    busy: boolean;
    examMode: ExamMode;
    questionCount: number;
    exportFolderPath: string;
    historyItems: readonly ExamHistoryItem[];
    selectedHistoryPath: string | null;
    selectedHistoryContent: string;
}

interface MutableExamViewState extends Omit<ExamViewState, "selectedScopeIds" | "excludedFilePaths" | "forceIncludedFilePaths" | "historyItems"> {
    selectedScopeIds: Set<string>;
    excludedFilePaths: Set<string>;
    forceIncludedFilePaths: Set<string>;
    historyItems: ExamHistoryItem[];
}

export type ExamControllerEvent =
    | { type: "state-changed" }
    | { type: "notice"; key: TranslationKey; replacements?: Record<string, string | number>; error?: unknown };

export type ExamControllerListener = (event: ExamControllerEvent) => void | Promise<void>;
type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/** Owns exam state and coordinates all asynchronous exam use cases. */
export class ExamController {
    private readonly listeners: Set<ExamControllerListener> = new Set();
    private activeAbortController: AbortController | null = null;
    private state: MutableExamViewState = {
        phase: "setup",
        session: null,
        selectedScopeIds: new Set<string>(["__all__"]),
        excludedFilePaths: new Set<string>(),
        forceIncludedFilePaths: new Set<string>(),
        showFileManager: false,
        fileSearchText: "",
        analysis: null,
        smartFilteringFailed: false,
        progressLabel: "",
        busy: false,
        examMode: "simple",
        questionCount: 5,
        exportFolderPath: "VaultCoach Exams",
        historyItems: [],
        selectedHistoryPath: null,
        selectedHistoryContent: "",
    };

    constructor(
        private readonly api: VaultCoachPluginApi,
        private readonly t: TranslateFn,
    ) {}

    getState(): Readonly<ExamViewState> {
        return {
            ...this.state,
            selectedScopeIds: new Set(this.state.selectedScopeIds),
            excludedFilePaths: new Set(this.state.excludedFilePaths),
            forceIncludedFilePaths: new Set(this.state.forceIncludedFilePaths),
            historyItems: [...this.state.historyItems],
        };
    }

    getScopeOptions(): ExamScopeOption[] {
        return this.api.getExamScopeOptions();
    }

    isSmartFilteringEnabled(): boolean {
        return this.api.settings.enableExamSmartFiltering;
    }

    getFileOptions(scopeOptions = this.getScopeOptions()): ExamFileOption[] {
        return this.api.getExamFileOptions(this.getSelectedFolderPaths(scopeOptions));
    }

    getScopeSnapshot(scopeOptions = this.getScopeOptions()): ExamScopeSnapshot {
        return this.api.getExamScopeSnapshot(this.getScopeSelection(scopeOptions));
    }

    /**
     * Starts the existing manual Exam workflow with exactly the source files
     * selected by another feature (currently Learning Map). This is a visible,
     * editable file scope, not an adaptive Exam target or a graph mutation.
     */
    prepareSourceScopedExam(filePaths: readonly string[]): boolean {
        if (this.state.busy) return false;
        const requested = new Set(filePaths.map((path) => path.trim()).filter((path) => path.length > 0));
        const allFiles = this.api.getExamFileOptions([]);
        const sourceFiles = allFiles.filter((file) => requested.has(file.filePath) && !file.permanentlyExcluded);
        if (sourceFiles.length === 0) return false;

        const sourcePaths = new Set(sourceFiles.map((file) => file.filePath));
        const narrowestSourceFolder = findNarrowestCommonSourceFolder(
            Array.from(sourcePaths),
            this.getScopeOptions(),
        );
        const scopedFiles = narrowestSourceFolder
            ? this.api.getExamFileOptions([narrowestSourceFolder.folderPath])
            : allFiles;
        this.state.session = null;
        this.state.phase = "setup";
        // Prefer the deepest directory containing every source. The visible
        // folder selection now tells the same story as the source-file scope;
        // only root/disjoint sources fall back to the full-vault option.
        this.state.selectedScopeIds = new Set<string>(narrowestSourceFolder ? [narrowestSourceFolder.id] : ["__all__"]);
        this.state.excludedFilePaths = new Set(scopedFiles
            .filter((file) => !sourcePaths.has(file.filePath))
            .map((file) => file.filePath));
        // The source has already been selected deliberately from graph
        // evidence, so smart content profiling must not silently remove it.
        this.state.forceIncludedFilePaths = sourcePaths;
        this.state.showFileManager = true;
        this.state.fileSearchText = "";
        this.invalidateAnalysis();
        this.notifyStateChanged();
        return true;
    }

    getScopeSelection(scopeOptions = this.getScopeOptions()): ExamScopeSelection {
        return {
            selectedFolderPaths: this.getSelectedFolderPaths(scopeOptions),
            excludedFilePaths: Array.from(this.state.excludedFilePaths),
            forceIncludedFilePaths: Array.from(this.state.forceIncludedFilePaths),
        };
    }

    hasScopeSelection(scopeOptions: ExamScopeOption[]): boolean {
        return this.state.selectedScopeIds.has("__all__") || scopeOptions.some((option) => {
            return option.folderPath !== null && this.state.selectedScopeIds.has(option.id);
        });
    }

    toggleScope(option: ExamScopeOption, isAllOption: boolean, checked: boolean): void {
        if (this.isSetupConfigurationLocked()) return;
        this.invalidateAnalysis();
        if (isAllOption) {
            if (checked) {
                this.state.selectedScopeIds = new Set<string>(["__all__"]);
            } else {
                this.state.selectedScopeIds.delete("__all__");
            }
            this.notifyStateChanged();
            return;
        }

        this.state.selectedScopeIds.delete("__all__");
        if (checked) {
            this.state.selectedScopeIds.add(option.id);
        } else {
            this.state.selectedScopeIds.delete(option.id);
        }
        this.notifyStateChanged();
    }

    setQuestionCount(value: string, maxQuestionCount = 10): void {
        if (this.isSetupConfigurationLocked()) return;
        this.state.questionCount = this.normalizeQuestionCount(value, maxQuestionCount);
        this.notifyStateChanged();
    }

    setExamMode(mode: ExamMode): void {
        if (this.isSetupConfigurationLocked() || this.state.examMode === mode) return;
        this.state.examMode = mode;
        this.invalidateAnalysis();
        this.notifyStateChanged();
    }

    setFileManagerVisible(visible: boolean): void {
        if (this.isSetupConfigurationLocked()) return;
        this.state.showFileManager = visible;
        this.notifyStateChanged();
    }

    setFileSearchText(value: string): void {
        this.state.fileSearchText = value;
        this.notifyStateChanged();
    }

    includeAllFiles(fileOptions: ExamFileOption[]): void {
        if (this.isSetupConfigurationLocked()) return;
        this.invalidateAnalysis();
        for (const option of fileOptions) {
            this.state.excludedFilePaths.delete(option.filePath);
        }
        this.notifyStateChanged();
    }

    excludeAllFiles(fileOptions: ExamFileOption[]): void {
        if (this.isSetupConfigurationLocked()) return;
        this.invalidateAnalysis();
        for (const option of fileOptions) {
            if (!option.permanentlyExcluded) {
                this.state.excludedFilePaths.add(option.filePath);
            }
        }
        this.notifyStateChanged();
    }

    resetFileSelection(fileOptions: ExamFileOption[]): void {
        if (this.isSetupConfigurationLocked()) return;
        this.invalidateAnalysis();
        for (const option of fileOptions) {
            this.state.excludedFilePaths.delete(option.filePath);
            this.state.forceIncludedFilePaths.delete(option.filePath);
        }
        this.notifyStateChanged();
    }

    setFileExcluded(option: ExamFileOption, excluded: boolean): void {
        if (this.isSetupConfigurationLocked()) return;
        this.invalidateAnalysis();
        if (excluded) {
            this.state.excludedFilePaths.add(option.filePath);
            this.state.forceIncludedFilePaths.delete(option.filePath);
        } else {
            this.state.excludedFilePaths.delete(option.filePath);
        }
        this.notifyStateChanged();
    }

    forceIncludeFile(option: ExamFileOption): void {
        if (this.isSetupConfigurationLocked()) return;
        this.invalidateAnalysis();
        this.state.forceIncludedFilePaths.add(option.filePath);
        this.state.excludedFilePaths.delete(option.filePath);
        this.notifyStateChanged();
    }

    async setSmartFilteringEnabled(enabled: boolean): Promise<void> {
        if (this.isSetupConfigurationLocked()) return;
        this.invalidateAnalysis();
        this.api.settings.enableExamSmartFiltering = enabled;
        await this.api.saveSettings();
        await this.emit({ type: "state-changed" });
    }

    setAnswer(index: number, answer: string): void {
        const session = this.state.session;
        if (!session || index < 0 || index >= session.questions.length) {
            return;
        }

        const userAnswers: string[] = [...session.userAnswers];
        userAnswers[index] = answer;
        this.state.session = { ...session, userAnswers };
    }

    setExportFolderPath(path: string): void {
        this.state.exportFolderPath = path;
    }

    async analyzeScope(forceRefresh: boolean): Promise<void> {
        if (this.isSetupConfigurationLocked()) {
            return;
        }

        this.state.busy = true;
        this.state.phase = "generating";
        this.state.session = null;
        this.state.smartFilteringFailed = false;
        this.state.progressLabel = this.t("exam.analysis.running");
        this.activeAbortController = new AbortController();
        await this.emit({ type: "state-changed" });

        try {
            this.state.analysis = await this.api.analyzeExamScope(this.getScopeSelection(), {
                forceProfileRefresh: forceRefresh,
                abortSignal: this.activeAbortController.signal,
                onProgress: (progress) => this.updateProgress(progress),
            });
            this.state.phase = "setup";
        } catch (error: unknown) {
            this.state.phase = "setup";
            if (isAbortError(error)) {
                await this.emit({ type: "notice", key: "exam.notice.cancelled" });
            } else {
                console.error("[VaultCoachExamController] 智能筛选失败", error);
                this.state.smartFilteringFailed = true;
                await this.emit({
                    type: "notice",
                    key: "exam.notice.analysisFailed",
                    error,
                });
            }
        } finally {
            await this.finishBusyOperation();
        }
    }

    async createExam(skipSemanticFiltering: boolean): Promise<void> {
        if (this.state.busy) {
            return;
        }

        this.state.busy = true;
        this.state.phase = "generating";
        this.state.session = null;
        this.state.progressLabel = this.t("exam.generating");
        this.activeAbortController = new AbortController();
        await this.emit({ type: "state-changed" });

        try {
            const session = await this.api.createExamSession(
                this.getScopeSelection(),
                this.state.questionCount,
                this.createGenerationOptions(skipSemanticFiltering),
            );
            this.state.session = session;
            this.state.analysis = null;
            this.state.smartFilteringFailed = false;
            this.state.phase = "taking";
            if (session.questions.length < this.state.questionCount) {
                await this.emit({
                    type: "notice",
                    key: "exam.notice.questionCountReduced",
                    replacements: { requested: this.state.questionCount, actual: session.questions.length },
                });
            }
        } catch (error: unknown) {
            this.state.phase = "setup";
            if (isAbortError(error)) {
                await this.emit({ type: "notice", key: "exam.notice.cancelled" });
            } else {
                console.error("[VaultCoachExamController] 创建考试失败", error);
                await this.emit({
                    type: "notice",
                    key: "exam.notice.createFailed",
                    error,
                });
            }
        } finally {
            await this.finishBusyOperation();
        }
    }

    async submitAnswers(answers: string[]): Promise<void> {
        const session = this.state.session;
        if (this.state.busy || !session) {
            return;
        }

        this.state.session = {
            ...session,
            userAnswers: session.questions.map((_question, index) => answers[index] ?? ""),
        };
        this.state.busy = true;
        this.state.phase = "evaluating";
        await this.emit({ type: "state-changed" });

        try {
            const evaluatedSession = await this.api.evaluateExamSession(this.state.session, this.state.session.userAnswers);
            this.state.session = evaluatedSession;
            try {
                this.state.session = await this.api.saveExamSession(evaluatedSession);
            } catch (error: unknown) {
                console.error("[VaultCoachExamController] 自动保存考试结果失败", error);
                await this.emit({
                    type: "notice",
                    key: "exam.notice.saveFailed",
                    error,
                });
            }
            this.state.phase = "review";
        } catch (error: unknown) {
            console.error("[VaultCoachExamController] 考试评分失败", error);
            this.state.phase = "taking";
            await this.emit({
                type: "notice",
                key: "exam.notice.evaluateFailed",
                error,
            });
        } finally {
            this.state.busy = false;
            await this.emit({ type: "state-changed" });
        }
    }

    async exportSession(): Promise<void> {
        if (this.state.busy || !this.state.session) {
            return;
        }

        this.state.busy = true;
        await this.emit({ type: "state-changed" });
        try {
            const path = await this.api.exportExamSession(this.state.session, this.state.exportFolderPath);
            await this.emit({ type: "notice", key: "exam.notice.exported", replacements: { path } });
        } catch (error: unknown) {
            console.error("[VaultCoachExamController] 导出考试失败", error);
            await this.emit({
                type: "notice",
                key: "exam.notice.exportFailed",
                error,
            });
        } finally {
            this.state.busy = false;
            await this.emit({ type: "state-changed" });
        }
    }

    async showHistory(): Promise<void> {
        if (this.state.busy) {
            return;
        }

        this.state.busy = true;
        this.state.phase = "history";
        this.state.selectedHistoryPath = null;
        this.state.selectedHistoryContent = "";
        await this.emit({ type: "state-changed" });
        try {
            this.state.historyItems = await this.api.listExamHistory();
        } catch (error: unknown) {
            console.error("[VaultCoachExamController] 读取考试历史失败", error);
            await this.emit({
                type: "notice",
                key: "exam.notice.historyFailed",
                error,
            });
        } finally {
            this.state.busy = false;
            await this.emit({ type: "state-changed" });
        }
    }

    async loadHistory(path: string): Promise<void> {
        if (this.state.busy) {
            return;
        }

        this.state.busy = true;
        this.state.selectedHistoryPath = path;
        this.state.selectedHistoryContent = "";
        await this.emit({ type: "state-changed" });
        try {
            this.state.selectedHistoryContent = await this.api.readExamHistoryContent(path);
        } catch (error: unknown) {
            console.error("[VaultCoachExamController] 读取考试历史内容失败", error);
            await this.emit({
                type: "notice",
                key: "exam.notice.historyFailed",
                error,
            });
        } finally {
            this.state.busy = false;
            await this.emit({ type: "state-changed" });
        }
    }

    async deleteHistory(path: string): Promise<void> {
        if (this.state.busy) {
            return;
        }

        this.state.busy = true;
        await this.emit({ type: "state-changed" });
        try {
            await this.api.deleteExamHistory(path);
            if (this.state.selectedHistoryPath === path) {
                this.state.selectedHistoryPath = null;
                this.state.selectedHistoryContent = "";
            }
            this.state.historyItems = await this.api.listExamHistory();
            await this.emit({ type: "notice", key: "exam.notice.deleted" });
        } catch (error: unknown) {
            console.error("[VaultCoachExamController] 删除考试历史失败", error);
            await this.emit({
                type: "notice",
                key: "exam.notice.deleteFailed",
                error,
            });
        } finally {
            this.state.busy = false;
            await this.emit({ type: "state-changed" });
        }
    }

    async deleteSession(): Promise<void> {
        if (this.state.busy || !this.state.session) {
            return;
        }

        this.state.busy = true;
        await this.emit({ type: "state-changed" });
        try {
            await this.api.deleteExamSession(this.state.session);
            this.resetSession();
            await this.emit({ type: "notice", key: "exam.notice.deleted" });
        } catch (error: unknown) {
            console.error("[VaultCoachExamController] 删除考试失败", error);
            await this.emit({
                type: "notice",
                key: "exam.notice.deleteFailed",
                error,
            });
        } finally {
            this.state.busy = false;
            await this.emit({ type: "state-changed" });
        }
    }

    cancelActiveOperation(): void {
        if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
            return;
        }

        this.activeAbortController.abort();
        this.state.progressLabel = this.t("exam.cancelling");
        this.notifyStateChanged();
    }

    resetSession(): void {
        this.state.session = null;
        this.state.phase = "setup";
        this.invalidateAnalysis();
        this.notifyStateChanged();
    }

    /**
     * Discards the completed analysis and reopens setup controls. A learner
     * must take this explicit step before changing the scope, count, or mode
     * used to produce the current analysis.
     */
    returnToSetup(): void {
        if (this.state.busy || !this.state.analysis) return;
        this.state.phase = "setup";
        this.invalidateAnalysis();
        this.notifyStateChanged();
    }

    returnFromHistory(): void {
        if (!this.state.session) {
            this.state.phase = "setup";
        } else if (this.state.session.evaluation) {
            this.state.phase = "review";
        } else {
            this.state.phase = "taking";
        }
        this.notifyStateChanged();
    }

    subscribe(listener: ExamControllerListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    dispose(): void {
        this.activeAbortController?.abort();
        this.activeAbortController = null;
        this.listeners.clear();
    }

    private getSelectedFolderPaths(scopeOptions: ExamScopeOption[]): string[] {
        if (this.state.selectedScopeIds.has("__all__")) {
            return [];
        }

        return scopeOptions.flatMap((option) => {
            return option.folderPath && this.state.selectedScopeIds.has(option.id) ? [option.folderPath] : [];
        });
    }

    private createGenerationOptions(skipSemanticFiltering: boolean): ExamGenerationOptions {
        return {
            analysis: skipSemanticFiltering ? undefined : this.state.analysis ?? undefined,
            examMode: this.state.examMode,
            skipSemanticFiltering,
            abortSignal: this.activeAbortController?.signal,
            onProgress: (progress) => this.updateProgress(progress),
        };
    }

    private updateProgress(progress: ExamGenerationProgress): void {
        this.state.progressLabel = this.formatProgress(progress);
        void this.emit({ type: "state-changed" });
    }

    private formatProgress(progress: ExamGenerationProgress): string {
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

    private async finishBusyOperation(): Promise<void> {
        this.state.busy = false;
        this.activeAbortController = null;
        this.state.progressLabel = "";
        await this.emit({ type: "state-changed" });
    }

    private invalidateAnalysis(): void {
        this.state.analysis = null;
        this.state.smartFilteringFailed = false;
    }

    private isSetupConfigurationLocked(): boolean {
        return this.state.busy || this.state.analysis !== null;
    }

    private normalizeQuestionCount(value: string, maxQuestionCount: number): number {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) {
            return 5;
        }

        const normalizedMax = Math.max(1, Math.min(10, maxQuestionCount || 10));
        return Math.max(1, Math.min(normalizedMax, parsed));
    }

    private notifyStateChanged(): void {
        void this.emit({ type: "state-changed" });
    }

    private async emit(event: ExamControllerEvent): Promise<void> {
        for (const listener of this.listeners) {
            await listener(event);
        }
    }
}

function findNarrowestCommonSourceFolder(
    sourcePaths: readonly string[],
    scopeOptions: readonly ExamScopeOption[],
): (ExamScopeOption & { folderPath: string }) | null {
    return scopeOptions
        .filter((option): option is ExamScopeOption & { folderPath: string } => option.folderPath !== null)
        .filter((option) => sourcePaths.every((path) => path.startsWith(`${option.folderPath}/`)))
        .sort((left, right) => right.folderPath.length - left.folderPath.length || left.folderPath.localeCompare(right.folderPath))[0]
        ?? null;
}
