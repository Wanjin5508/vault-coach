/**
 * 插件设置的持久化契约。
 *
 * 设置在进入应用服务前必须与默认值合并并完成边界校验。`*SecretName` 保存的是安全存储键名，
 * 不能保存明文凭据。影响解析、分块或向量模型的字段变更必须使相应索引失效。
 */
import type { RetrievalMode } from "../../domain/retrieval/retrieval-types";

export type KnowledgeScopeMode = "wholeVault" | "specificFolder";
export type ModelProvider = "ollama" | "openai-compatible";
export type EmbeddingProvider = "ollama" | "openai-compatible";

/**
 * 经默认值合并和校验后提供给应用服务的完整设置。
 * 新增字段必须同时更新默认设置、设置迁移、校验和设置界面。
 */
export interface VaultCoachSettings {
    enableMarkdownIndexing: boolean;
    enablePdfIndexing: boolean;
    maxPdfFileSizeMb: number;
    maxPdfPageCount: number;
    assistantName: string;
    defaultGreeting: string;
    openInRightSidebarOnStartup: boolean;
    knowledgeScopeMode: KnowledgeScopeMode;
    knowledgeFolder: string;
    chunkSize: number;
    chunkOverlap: number;
    keywordSearchTopK: number;
    vectorSearchTopK: number;
    hybridSearchTopK: number;
    rerankTopK: number;
    contextTopK: number;
    answerSourceLimit: number;
    collapseSourcesByDefault: boolean;
    defaultRetrievalMode: RetrievalMode;
    enableQueryRewrite: boolean;
    enableVectorRetrieval: boolean;
    enableRerank: boolean;
    generationTemperature: number;
    modelProvider: ModelProvider;
    cloudBaseUrl: string;
    cloudChatModel: string;
    cloudApiKeySecretName: string;
    llmBaseUrl: string;
    chatModel: string;
    embeddingModel: string;
    embeddingProvider: EmbeddingProvider;
    cloudEmbeddingBaseUrl: string;
    cloudEmbeddingModel: string;
    rerankBaseUrl: string;
    rerankModel: string;
    enableLongTermMemory: boolean;
    memoryTopK: number;
    memoryMaxItems: number;
    maxConversationMessages: number;
    enableAutoIndexSync: boolean;
    autoIndexDebounceMs: number;
    autoIndexMaxWaitMs: number;
    autoIndexFileThreshold: number;
    examExcludePathPatterns: string;
    enableExamSmartFiltering: boolean;
    /** 显式授权开关：语义抽取可以把 Section 摘要发送给用户选择的模型。 */
    enableSemanticGraph: boolean;
    enableSemanticGraphAutoSync: boolean;
    /** 允许模型抽取超过 Lite 单文件安全阈值的文件。 */
    semanticGraphIncludeLargeFiles: boolean;
    semanticGraphMaxSectionsPerRun: number;
    semanticGraphMaxSectionCharacters: number;
    semanticGraphSimilarityTopK: number;
    semanticGraphSimilarityThreshold: number;
    /** 在 Learning Map 展示高置信候选，但不得将其转为已确认事实。 */
    learningMapAutoRelationsEnabled: boolean;
    learningMapAutoModelThreshold: number;
    learningMapAutoIncludeRuleRelations: boolean;
    learningMapAutoIncludeSimilarityRelations: boolean;
}
