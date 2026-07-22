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
import type {
    ConceptEvidenceRef,
    ConceptReviewProjection,
    ConceptReviewQuery,
    SemanticGraphStateView,
    SemanticRelationType,
} from "../domain/semantic-graph/semantic-graph-types";
import type { LearningGraphConceptCatalog, LearningGraphProjection, LearningGraphQuery } from "../domain/learning-graph/learning-graph-types";
import type { ConceptMasteryState, MasterySnapshotV1, MasteryStateView } from "../domain/mastery/mastery-types";

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

/** Separate facade: M3 decisions never change M2 structural graph facts. */
export interface SemanticGraphApplicationApi {
    rebuild(signal?: AbortSignal): Promise<void>;
    clear(): Promise<void>;
    abort(): void;
    getState(): SemanticGraphStateView;
    getReviewProjection(query?: ConceptReviewQuery): Promise<ConceptReviewProjection>;
    confirmCandidate(fingerprint: string): Promise<void>;
    rejectCandidate(fingerprint: string, reason?: string): Promise<void>;
    undoCandidateDecision(decisionId: string): Promise<void>;
    mergeConcepts(canonicalConceptId: string, mergedConceptIds: readonly string[]): Promise<void>;
    undoMerge(decisionId: string): Promise<void>;
    addAlias(conceptId: string, alias: string): Promise<void>;
    removeAlias(conceptId: string, alias: string): Promise<void>;
    createManualRelation(type: SemanticRelationType, sourceConceptId: string, targetConceptId: string, evidence?: readonly ConceptEvidenceRef[], note?: string): Promise<void>;
    removeManualRelation(relationId: string): Promise<void>;
    undoManualRelationRemoval(decisionId: string): Promise<void>;
}

/** Read-only M2 + M3 projection consumed by M4B and the Learning Map. */
export interface LearningGraphApplicationApi {
    getProjection(query?: LearningGraphQuery): Promise<LearningGraphProjection>;
    getConceptCatalog(): Promise<LearningGraphConceptCatalog>;
}

/** M4B exposes derived mastery facts without coupling a future UI to storage. */
export interface MasteryApplicationApi {
    getState(): MasteryStateView;
    getSnapshot(): MasterySnapshotV1 | null;
    getConceptState(conceptId: string): ConceptMasteryState | null;
    rebuild(): Promise<MasterySnapshotV1>;
    clear(): Promise<void>;
}

export interface ProgressApplicationApi { isAvailable(): false; }

export interface VaultCoachApplicationApi {
    chat: ChatApplicationApi;
    exam: ExamApplicationApi;
    index: IndexApplicationApi;
    graph: GraphApplicationApi;
    semanticGraph: SemanticGraphApplicationApi;
    learningGraph: LearningGraphApplicationApi;
    mastery: MasteryApplicationApi;
    progress: ProgressApplicationApi;
}
