import type { ChatMessage, StreamHandlers } from "./chat/chat-types";
import type { AssistantAnswer } from "../domain/retrieval/retrieval-types";
import type {
    ExamFileOption, ExamGenerationOptions, ExamHistoryItem, ExamScopeAnalysisResult,
    ExamScopeOption, ExamScopeSelection, ExamScopeSnapshot, ExamSession,
} from "../domain/exam/exam-types";
import type { KnowledgeBaseStats } from "../domain/documents/document-types";
import type { KnowledgeIndexBusyState } from "./index/index-types";
import type { VectorIndexStats } from "../domain/retrieval/retrieval-types";
import type {
    GraphIntegrityReport,
    GraphSnapshotV1,
    GraphSourceLocation,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
} from "../domain/graph/graph-types";

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

/** The only graph entry point available to future presentation code. */
export interface GraphApplicationApi {
    rebuild(signal?: AbortSignal): Promise<GraphSnapshotV1>;
    getSnapshot(): Promise<GraphSnapshotV1 | null>;
    getNode(nodeId: string): Promise<KnowledgeGraphNode | null>;
    findNodesByDocumentPath(filePath: string): Promise<KnowledgeGraphNode[]>;
    findEdgesForNode(nodeId: string): Promise<KnowledgeGraphEdge[]>;
    findEdgesBySourceFile(filePath: string): Promise<KnowledgeGraphEdge[]>;
    getEdgeSources(edgeId: string): Promise<GraphSourceLocation[]>;
    checkIntegrity(): Promise<GraphIntegrityReport>;
}

export interface ProgressApplicationApi { isAvailable(): false; }

export interface VaultCoachApplicationApi {
    chat: ChatApplicationApi;
    exam: ExamApplicationApi;
    index: IndexApplicationApi;
    graph: GraphApplicationApi;
    progress: ProgressApplicationApi;
}
