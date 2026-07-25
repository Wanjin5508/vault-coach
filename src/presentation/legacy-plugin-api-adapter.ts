import type { VaultCoachApplicationApi } from "../app/application-api";
import type {
    AnswerSource,
    AssistantAnswer,
    RetrievalMode,
} from "../domain/retrieval/retrieval-types";
import type { ChatMessage, StreamHandlers } from "../app/chat/chat-types";
import type {
    ExamFileOption,
    ExamGenerationOptions,
    ExamHistoryItem,
    ExamScopeAnalysisResult,
    ExamScopeOption,
    ExamScopeSelection,
    ExamScopeSnapshot,
    ExamSession,
} from "../domain/exam/exam-types";
import type { VaultCoachSettings } from "../app/config/settings-types";
import type { VaultCoachPluginApi } from "./plugin-api";
import type { SourceInventoryStatus } from "../domain/index-lifecycle/source-inventory";
import type { AdaptiveExamPlanRequest, AdaptiveExamPlanResult } from "../domain/adaptive-exam/adaptive-exam-types";

type ApplicationDelegatedMethod =
    | "resetConversation"
    | "getMessages"
    | "appendUserMessage"
    | "streamAssistantTurn"
    | "getExamScopeOptions"
    | "getExamFileOptions"
    | "getExamScopeSnapshot"
    | "analyzeExamScope"
    | "previewAdaptiveExamPlan"
    | "createExamSession"
    | "evaluateExamSession"
    | "saveExamSession"
    | "exportExamSession"
    | "listExamHistory"
    | "readExamHistoryContent"
    | "deleteExamSession"
    | "deleteExamHistory";

/**
 * Host capabilities that remain Obsidian-bound while the old presentation API
 * is still in use. Index operations with a Notice retain their existing host
 * implementation until a notification port is introduced.
 */
export type LegacyPluginApiHost = Omit<VaultCoachPluginApi, ApplicationDelegatedMethod>;

/**
 * Preserves the flat presentation API during the controller migration.
 *
 * New use-case calls delegate to the grouped application facade. The remaining
 * host callbacks are UI or Obsidian lifecycle concerns and will move out of the
 * plugin in the later composition-root step.
 */
export class LegacyPluginApiAdapter implements VaultCoachPluginApi {
    constructor(
        private readonly application: VaultCoachApplicationApi,
        private readonly host: LegacyPluginApiHost,
    ) {}

    get settings(): VaultCoachSettings {
        return this.host.settings;
    }

    set settings(value: VaultCoachSettings) {
        this.host.settings = value;
    }

    saveSettings(): Promise<void> {
        return this.host.saveSettings();
    }

    activateView(): Promise<void> {
        return this.host.activateView();
    }

    refreshAllViews(): void {
        this.host.refreshAllViews();
    }

    resetConversation(): void {
        this.application.chat.resetConversation();
    }

    markKnowledgeBaseDirty(): void {
        this.host.markKnowledgeBaseDirty();
    }

    markVectorIndexDirty(): void {
        this.host.markVectorIndexDirty();
    }

    async rebuildKnowledgeBase(showNotice: boolean, signal?: AbortSignal): Promise<void> {
        if (showNotice) {
            await this.host.rebuildKnowledgeBase(true, signal);
            return;
        }

        await this.application.index.rebuild(signal);
    }

    async clearKnowledgeIndex(showNotice: boolean): Promise<void> {
        if (showNotice) {
            await this.host.clearKnowledgeIndex(true);
            return;
        }

        await this.application.index.clear();
    }

    abortKnowledgeIndexBuild(showNotice: boolean): void {
        if (showNotice) {
            this.host.abortKnowledgeIndexBuild(true);
            return;
        }

        this.application.index.abort();
    }

    isTextIndexDirty(): boolean {
        return this.host.isTextIndexDirty();
    }

    isVectorIndexDirty(): boolean {
        return this.host.isVectorIndexDirty();
    }

    getSourceInventoryStatus(): SourceInventoryStatus {
        return this.host.getSourceInventoryStatus();
    }

    getKnowledgeIndexBusyState() {
        return this.application.index.getState().busy;
    }

    getKnowledgeBaseStats() {
        return this.application.index.getState().stats;
    }

    getVectorIndexStats() {
        return this.application.index.getState().vectorStats;
    }

    getLocalizedKnowledgeScopeDescription(): string {
        return this.host.getLocalizedKnowledgeScopeDescription();
    }

    getEffectiveDefaultGreeting(): string {
        return this.host.getEffectiveDefaultGreeting();
    }

    getRuntimeRetrievalMode(): RetrievalMode {
        return this.host.getRuntimeRetrievalMode();
    }

    setRuntimeRetrievalMode(mode: RetrievalMode): void {
        this.host.setRuntimeRetrievalMode(mode);
    }

    getActiveChatModelName(): string {
        return this.host.getActiveChatModelName();
    }

    getActiveEmbeddingModelName(): string {
        return this.host.getActiveEmbeddingModelName();
    }

    getMessages(): ChatMessage[] {
        return [...this.application.chat.getMessages()];
    }

    getMemoryCount(): number {
        return this.host.getMemoryCount();
    }

    appendUserMessage(text: string): Promise<void> {
        return this.application.chat.appendUserMessage(text);
    }

    streamAssistantTurn(userText: string, handlers?: StreamHandlers): Promise<AssistantAnswer> {
        return this.application.chat.streamAssistantTurn(userText, handlers);
    }

    openSource(source: AnswerSource): Promise<void> {
        return this.host.openSource(source);
    }

    getExamScopeOptions(): ExamScopeOption[] {
        return this.application.exam.getScopeOptions();
    }

    getExamFileOptions(selectedFolderPaths: string[]): ExamFileOption[] {
        return this.application.exam.getFileOptions(selectedFolderPaths);
    }

    getExamScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot {
        return this.application.exam.getScopeSnapshot(selection);
    }

    analyzeExamScope(selection: ExamScopeSelection, options?: ExamGenerationOptions): Promise<ExamScopeAnalysisResult> {
        return this.application.exam.analyzeScope(selection, options);
    }

    previewAdaptiveExamPlan(request: AdaptiveExamPlanRequest): Promise<AdaptiveExamPlanResult> {
        return this.application.exam.previewAdaptivePlan(request);
    }

    createExamSession(
        selection: ExamScopeSelection,
        questionCount: number,
        options?: ExamGenerationOptions,
    ): Promise<ExamSession> {
        return this.application.exam.createSession(selection, questionCount, options);
    }

    evaluateExamSession(session: ExamSession, userAnswers: string[]): Promise<ExamSession> {
        return this.application.exam.submitSession(session, userAnswers);
    }

    saveExamSession(session: ExamSession): Promise<ExamSession> {
        return this.application.exam.saveSession(session);
    }

    exportExamSession(session: ExamSession, targetFolderPath: string): Promise<string> {
        return this.application.exam.exportSession(session, targetFolderPath);
    }

    listExamHistory(): Promise<ExamHistoryItem[]> {
        return this.application.exam.listHistory();
    }

    readExamHistoryContent(path: string): Promise<string> {
        return this.application.exam.readHistory(path);
    }

    deleteExamSession(session: ExamSession): Promise<void> {
        return this.application.exam.deleteSession(session);
    }

    deleteExamHistory(path: string): Promise<void> {
        return this.application.exam.deleteHistory(path);
    }
}
