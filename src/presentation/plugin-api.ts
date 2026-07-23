import type { Plugin } from "obsidian";
import type {
    AnswerSource,
    AssistantAnswer,
    RetrievalMode,
    VectorIndexStats,
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
import type { KnowledgeBaseStats } from "../domain/documents/document-types";
import type { KnowledgeIndexBusyState } from "../app/index/index-types";
import type { VaultCoachSettings } from "../app/config/settings-types";
import type { SourceInventoryStatus } from "../domain/index-lifecycle/source-inventory";

/**
 * UI 层和设置页能调用的插件能力。
 *
 * 该接口在里程碑 0 期间保持稳定，由兼容适配器提供实现；新 Controller
 * 将在后续步骤直接使用分组 Application API。
 */
export interface VaultCoachPluginApi {
    settings: VaultCoachSettings;

    saveSettings(): Promise<void>;
    activateView(): Promise<void>;
    refreshAllViews(): void;
    resetConversation(): void;

    markKnowledgeBaseDirty(): void;
    markVectorIndexDirty(): void;
    rebuildKnowledgeBase(showNotice: boolean, signal?: AbortSignal): Promise<void>;
    clearKnowledgeIndex(showNotice: boolean): Promise<void>;
    abortKnowledgeIndexBuild(showNotice: boolean): void;
    isTextIndexDirty(): boolean;
    isVectorIndexDirty(): boolean;
    getSourceInventoryStatus(): SourceInventoryStatus;
    getKnowledgeIndexBusyState(): KnowledgeIndexBusyState;
    getKnowledgeBaseStats(): KnowledgeBaseStats;
    getVectorIndexStats(): VectorIndexStats;
    getLocalizedKnowledgeScopeDescription(): string;

    getEffectiveDefaultGreeting(): string;
    getRuntimeRetrievalMode(): RetrievalMode;
    setRuntimeRetrievalMode(mode: RetrievalMode): void;
    getActiveChatModelName(): string;
    getActiveEmbeddingModelName(): string;
    getMessages(): ChatMessage[];
    getMemoryCount(): number;
    appendUserMessage(text: string): Promise<void>;
    streamAssistantTurn(userText: string, handlers?: StreamHandlers): Promise<AssistantAnswer>;
    openSource(source: AnswerSource): Promise<void>;

    getExamScopeOptions(): ExamScopeOption[];
    getExamFileOptions(selectedFolderPaths: string[]): ExamFileOption[];
    getExamScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot;
    analyzeExamScope(selection: ExamScopeSelection, options?: ExamGenerationOptions): Promise<ExamScopeAnalysisResult>;
    createExamSession(
        selection: ExamScopeSelection,
        questionCount: number,
        options?: ExamGenerationOptions,
    ): Promise<ExamSession>;
    evaluateExamSession(session: ExamSession, userAnswers: string[]): Promise<ExamSession>;
    saveExamSession(session: ExamSession): Promise<ExamSession>;
    exportExamSession(session: ExamSession, targetFolderPath: string): Promise<string>;
    listExamHistory(): Promise<ExamHistoryItem[]>;
    readExamHistoryContent(path: string): Promise<string>;
    deleteExamSession(session: ExamSession): Promise<void>;
    deleteExamHistory(path: string): Promise<void>;
}

export type VaultCoachPluginInstance = Plugin & VaultCoachPluginApi;
