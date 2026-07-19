import type { ChatMessage, StreamHandlers } from "./chat/chat-types";
import type { AssistantAnswer } from "../domain/retrieval/retrieval-types";
import type {
    ExamFileOption, ExamGenerationOptions, ExamHistoryItem, ExamScopeAnalysisResult,
    ExamScopeOption, ExamScopeSelection, ExamScopeSnapshot, ExamSession,
} from "../domain/exam/exam-types";
import type { KnowledgeBaseStats } from "../domain/documents/document-types";
import type { KnowledgeIndexBusyState } from "./index/index-types";
import type { VectorIndexStats } from "../domain/retrieval/retrieval-types";

export interface ChatApplicationApi {
    getMessages(): readonly ChatMessage[];
    appendUserMessage(text: string): Promise<void>;
    streamAssistantTurn(text: string, handlers?: StreamHandlers): Promise<AssistantAnswer>;
    resetConversation(): void;
}

export interface ExamApplicationApi {
    getScopeOptions(): ExamScopeOption[];
    getFileOptions(folderPaths: string[]): ExamFileOption[];
    getScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot;
    analyzeScope(selection: ExamScopeSelection, options?: ExamGenerationOptions): Promise<ExamScopeAnalysisResult>;
    createSession(selection: ExamScopeSelection, count: number, options?: ExamGenerationOptions): Promise<ExamSession>;
    submitSession(session: ExamSession, answers: string[]): Promise<ExamSession>;
    saveSession(session: ExamSession): Promise<ExamSession>;
    exportSession(session: ExamSession, folderPath: string): Promise<string>;
    listHistory(): Promise<ExamHistoryItem[]>;
    readHistory(path: string): Promise<string>;
    deleteSession(session: ExamSession): Promise<void>;
    deleteHistory(path: string): Promise<void>;
}

export interface KnowledgeIndexViewState {
    textDirty: boolean;
    vectorDirty: boolean;
    busy: KnowledgeIndexBusyState;
    stats: KnowledgeBaseStats;
    vectorStats: VectorIndexStats;
}

export interface IndexApplicationApi {
    rebuild(signal?: AbortSignal): Promise<void>;
    clear(): Promise<void>;
    abort(): void;
    getState(): KnowledgeIndexViewState;
}

export interface ProgressApplicationApi { isAvailable(): false; }

export interface VaultCoachApplicationApi {
    chat: ChatApplicationApi;
    exam: ExamApplicationApi;
    index: IndexApplicationApi;
    progress: ProgressApplicationApi;
}
