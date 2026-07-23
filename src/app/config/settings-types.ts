import type { RetrievalMode } from "../../domain/retrieval/retrieval-types";

export type KnowledgeScopeMode = "wholeVault" | "specificFolder";
export type ModelProvider = "ollama" | "openai-compatible";
export type EmbeddingProvider = "ollama" | "openai-compatible";

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
    /** Explicit opt-in: semantic extraction may send Section excerpts to the selected model. */
    enableSemanticGraph: boolean;
    enableSemanticGraphAutoSync: boolean;
    semanticGraphMaxSectionsPerRun: number;
    semanticGraphMaxSectionCharacters: number;
    semanticGraphSimilarityTopK: number;
    semanticGraphSimilarityThreshold: number;
    /** Shows high-confidence proposals in Learning Map without turning them into confirmed facts. */
    learningMapAutoRelationsEnabled: boolean;
    learningMapAutoModelThreshold: number;
    learningMapAutoIncludeRuleRelations: boolean;
    learningMapAutoIncludeSimilarityRelations: boolean;
}
