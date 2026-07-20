/**
 * @deprecated 兼容旧模块的类型入口。
 *
 * 新代码必须从类型所属的 domain/app/infrastructure 模块导入；本文件只保留
 * 显式 re-export，避免迁移期间一次性修改所有消费者造成无关行为变化。
 */

export type {
    ChunkContentKind,
    DocumentLocator,
    DocumentMetadata,
    DocumentParseContext,
    DocumentParseProgress,
    IndexedChunk,
    KnowledgeBaseFileRecord,
    KnowledgeBaseStats,
    KnowledgeBaseSyncResult,
    KnowledgeDocumentType,
    MarkdownLocator,
    ParsedDocument,
    ParsedDocumentBlock,
    ParsedDocumentBlockKind,
    PdfExtractionReport,
    PdfLocator,
    ZoteroLocator,
} from "./domain/documents/document-types";

export type {
    AnswerSource,
    AssistantAnswer,
    ChunkEmbedding,
    KeywordSearchHit,
    QueryRewriteResult,
    RerankResultItem,
    RerankedCandidate,
    RetrievalCandidate,
    RetrievalMode,
    VectorIndexStats,
    VectorRecord,
    VectorSearchHit,
    VectorSearchOptions,
    VectorStore,
    VectorStoreHit,
    VectorStoreStats,
} from "./domain/retrieval/retrieval-types";

export type {
    AssessmentErrorCode,
    ExamBlueprint,
    ExamBlueprintItem,
    ExamContentDecision,
    ExamContentProfile,
    ExamContentProfileCache,
    ExamContentProfileCacheKey,
    ExamContentProfileCacheRecord,
    ExamExclusionReason,
    ExamEvaluation,
    ExamEvaluationItem,
    ExamFileOption,
    ExamGenerationDiagnostics,
    ExamGenerationOptions,
    ExamGenerationPhase,
    ExamGenerationProgress,
    ExamHistoryItem,
    ExamDifficulty,
    ExamEvaluationMetadata,
    ExamQuestion,
    ExamQuestionReview,
    ExamQuestionType,
    ExamScopeAnalysisResult,
    ExamScopeAnalysisSummary,
    ExamScopeOption,
    ExamScopeSelection,
    ExamScopeSnapshot,
    ExamSession,
    ExamSessionStatus,
    GeneratedExamQuestionCandidate,
    ModelPromptMetadata,
} from "./domain/exam/exam-types";

export type {
    AssessmentConceptBinding,
    AssessmentEvent,
    AssessmentEventCreationResult,
    AssessmentSessionIndexEntry,
    AssessmentSessionIndexV1,
    AssessmentSessionDocumentV1,
    AssessmentSessionStore,
} from "./domain/assessment/assessment-types";

export type {
    LocalChatMessage,
} from "./domain/model/model-types";

export type {
    MemoryItem,
    MemorySearchHit,
} from "./domain/memory/memory-types";

export type {
    ChatMessage,
    ChatRole,
    StreamHandlers,
} from "./app/chat/chat-types";

export type {
    EmbeddingProvider,
    KnowledgeScopeMode,
    ModelProvider,
    VaultCoachSettings,
} from "./app/config/settings-types";

export type {
    KnowledgeIndexBusyPhase,
    KnowledgeIndexBusyState,
} from "./app/index/index-types";

export type {
    KnowledgeBaseSnapshot,
    PersistedPluginState,
} from "./infrastructure/storage/storage-types";
