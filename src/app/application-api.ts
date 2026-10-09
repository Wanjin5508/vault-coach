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
    SemanticGovernanceImpact,
    SemanticRelationType,
} from "../domain/semantic-graph/semantic-graph-types";
import type { LearningGraphConceptCatalog, LearningGraphProjection, LearningGraphQuery } from "../domain/learning-graph/learning-graph-types";
import type { ConceptMasteryState, MasterySnapshotV1, MasteryStateView } from "../domain/mastery/mastery-types";
import type { ProgressSnapshot, ProgressStateView } from "./progress/progress-types";
import type { SourceInventoryDiff, SourceInventoryStatus } from "../domain/index-lifecycle/source-inventory";
import type { StorageFootprint } from "../domain/index-lifecycle/storage-footprint";
import type { AdaptiveExamPlanRequest, AdaptiveExamPlanResult } from "../domain/adaptive-exam/adaptive-exam-types";
import type { RecommendationSnapshot, ReviewAction } from "../domain/recommendation/recommendation-types";
import type { KnowledgeEngineAvailability, KnowledgeEngineDiagnostics } from "./engine/knowledge-engine-types";

/** 展示层使用的聊天门面；会话持久化和 RAG 编排由应用层完成。 */
export interface ChatApplicationApi {
    getMessages(): readonly ChatMessage[];
    appendUserMessage(text: string): Promise<void>;
    streamAssistantTurn(text: string, handlers?: StreamHandlers): Promise<AssistantAnswer>;
    resetConversation(): void;
}

/** 考试用例门面；调用方不能绕过它直接写历史记录或评估事实。 */
export interface ExamApplicationApi {
    getScopeOptions(): ExamScopeOption[];
    getFileOptions(folderPaths: string[]): ExamFileOption[];
    getScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot;
    analyzeScope(selection: ExamScopeSelection, options?: ExamGenerationOptions): Promise<ExamScopeAnalysisResult>;
    previewAdaptivePlan(request: AdaptiveExamPlanRequest): Promise<AdaptiveExamPlanResult>;
    createSession(selection: ExamScopeSelection, count: number, options?: ExamGenerationOptions): Promise<ExamSession>;
    submitSession(session: ExamSession, answers: string[]): Promise<ExamSession>;
    saveSession(session: ExamSession): Promise<ExamSession>;
    exportSession(session: ExamSession, folderPath: string): Promise<string>;
    listHistory(): Promise<ExamHistoryItem[]>;
    readHistory(path: string): Promise<string>;
    deleteSession(session: ExamSession): Promise<void>;
    deleteHistory(path: string): Promise<void>;
}

/** 知识索引的完整展示快照；脏状态与后台任务状态具有独立语义。 */
export interface KnowledgeIndexViewState {
    textDirty: boolean;
    vectorDirty: boolean;
    sourceInventoryStatus: SourceInventoryStatus;
    sourceInventoryDiff: SourceInventoryDiff | null;
    busy: KnowledgeIndexBusyState;
    stats: KnowledgeBaseStats;
    vectorStats: VectorIndexStats;
}

/** 索引生命周期门面；重建和清理的并发控制由应用层负责。 */
export interface IndexApplicationApi {
    rebuild(signal?: AbortSignal): Promise<void>;
    clear(): Promise<void>;
    abort(): void;
    getState(): KnowledgeIndexViewState;
    getStorageFootprint(): Promise<StorageFootprint>;
}

/** 展示层访问确定性知识图谱的唯一入口。 */
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

/** 独立的语义图门面；M3 用户决策不得修改 M2 结构图事实。 */
export interface SemanticGraphApplicationApi {
    rebuild(signal?: AbortSignal): Promise<void>;
    clear(): Promise<void>;
    /** 仅清除用户创建的语义决策；已抽取事实和 embedding 继续保留。 */
    resetGovernanceDecisions(): Promise<void>;
    getGovernanceImpact(): SemanticGovernanceImpact;
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

/** 供 M4B 和 Learning Map 使用的 M2 + M3 只读投影。 */
export interface LearningGraphApplicationApi {
    getProjection(query?: LearningGraphQuery): Promise<LearningGraphProjection>;
    getConceptCatalog(): Promise<LearningGraphConceptCatalog>;
}

/** 暴露 M4B 派生掌握度事实，避免展示层依赖具体存储实现。 */
export interface MasteryApplicationApi {
    getState(): MasteryStateView;
    getSnapshot(): MasterySnapshotV1 | null;
    getConceptState(conceptId: string): ConceptMasteryState | null;
    rebuild(): Promise<MasterySnapshotV1>;
    clear(): Promise<void>;
}

/**
 * Dashboard 只读契约。L5.1 仅提供聚合事实；M5 的界面实现留在展示层，
 * 推荐策略由 M7 负责。
 */
export interface ProgressApplicationApi {
    isAvailable(): boolean;
    getState(): ProgressStateView;
    getSnapshot(): Promise<ProgressSnapshot>;
}

/**
 * M7 推荐门面。一次性推荐与小型持久化操作日志通过不同接口暴露，
 * 确保展示层不直接写存储文件，也不直接修改掌握度或图事实。
 */
export interface RecommendationApplicationApi {
    isAvailable(): boolean;
    getSnapshot(): Promise<RecommendationSnapshot>;
    recordAction(recommendationId: string, action: ReviewAction, deferUntil?: number): Promise<void>;
    exportMarkdown(): Promise<string>;
}

/**
 * Engine 只读接缝。VC-L8 暴露诊断信息，但不能让任何外部服务成为 Lite 流程的前置条件，
 * 也不能允许展示层调用任意 URL。
 */
export interface KnowledgeEngineApplicationApi {
    getAvailability(): KnowledgeEngineAvailability;
    getDiagnostics(): KnowledgeEngineDiagnostics;
    refresh(signal?: AbortSignal): Promise<KnowledgeEngineAvailability>;
}

/**
 * 展示层的应用入口。按用例分组的子门面是稳定依赖边界，
 * UI 不应通过类型断言访问容器内的具体服务或基础设施实现。
 */
export interface VaultCoachApplicationApi {
    chat: ChatApplicationApi;
    exam: ExamApplicationApi;
    index: IndexApplicationApi;
    graph: GraphApplicationApi;
    semanticGraph: SemanticGraphApplicationApi;
    learningGraph: LearningGraphApplicationApi;
    mastery: MasteryApplicationApi;
    progress: ProgressApplicationApi;
    recommendations: RecommendationApplicationApi;
    engine: KnowledgeEngineApplicationApi;
}
