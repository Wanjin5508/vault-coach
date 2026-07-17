import type { Plugin } from "obsidian";
import type {
    AnswerSource,
    AssistantAnswer,
    ChatMessage,
    ExamFileOption,
    ExamGenerationOptions,
    ExamHistoryItem,
    ExamScopeAnalysisResult,
    ExamScopeOption,
    ExamScopeSelection,
    ExamScopeSnapshot,
    ExamSession,
    KnowledgeBaseStats,
    KnowledgeIndexBusyState,
    RetrievalMode,
    StreamHandlers,
    VaultCoachSettings,
    VectorIndexStats,
} from "./types";

/**
 * UI 层和设置页能调用的插件能力。
 *
 * 视图不依赖 VaultCoach 主类实现，只依赖这里定义的稳定协作接口。
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
