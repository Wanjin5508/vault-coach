import { createDefaultSettings } from "../../app/config/settings-defaults";
import type { VaultCoachSettings } from "../../app/config/settings-types";
import type { TranslationKey } from "../../i18n";

export type SettingsTier = "basic" | "advanced";
export type SettingsVirtualItemId =
    | "knowledgeScope"
    | "semanticStatus"
    | "builtinEmbeddingRuntime"
    | "cloudApiKey"
    | "embeddingLocalBaseUrl"
    | "embeddingCloudApiKey";
export type SettingsItemId = Exclude<keyof VaultCoachSettings, "defaultRetrievalMode"> | SettingsVirtualItemId;

export interface SettingsCategoryDefinition {
    id: string;
    tier: SettingsTier;
    titleKey: TranslationKey;
    itemKeys: readonly SettingsItemId[];
}

/** 声明式与命令式设置页共享的唯一类别和字段顺序。 */
export const SETTINGS_CATEGORIES: readonly SettingsCategoryDefinition[] = [
    {
        id: "basic-knowledge",
        tier: "basic",
        titleKey: "settings.knowledge.heading",
        itemKeys: ["knowledgeScope", "enableMarkdownIndexing", "enablePdfIndexing", "semanticStatus"],
    },
    {
        id: "basic-answer-model",
        tier: "basic",
        titleKey: "settings.category.answerModel",
        itemKeys: ["modelProvider", "llmBaseUrl", "chatModel", "cloudBaseUrl", "cloudChatModel", "cloudApiKey"],
    },
    {
        id: "basic-interface",
        tier: "basic",
        titleKey: "settings.category.interface",
        itemKeys: ["assistantName", "defaultGreeting", "openInRightSidebarOnStartup", "collapseSourcesByDefault"],
    },
    {
        id: "advanced-embedding",
        tier: "advanced",
        titleKey: "settings.category.embedding",
        itemKeys: [
            "embeddingProvider", "builtinEmbeddingRuntime", "embeddingLocalBaseUrl", "embeddingModel", "cloudEmbeddingBaseUrl",
            "cloudEmbeddingModel", "embeddingCloudApiKey", "enableVectorRetrieval",
        ],
    },
    {
        id: "advanced-retrieval",
        tier: "advanced",
        titleKey: "settings.category.retrieval",
        itemKeys: [
            "retrievalPreference", "enableQueryRewrite", "enableRerank", "rerankBaseUrl", "rerankModel",
            "keywordSearchTopK", "vectorSearchTopK", "hybridSearchTopK", "rerankTopK", "contextTopK",
            "answerSourceLimit", "generationTemperature",
        ],
    },
    {
        id: "advanced-indexing",
        tier: "advanced",
        titleKey: "settings.category.indexing",
        itemKeys: [
            "maxPdfFileSizeMb", "maxPdfPageCount", "chunkSize", "chunkOverlap", "enableAutoIndexSync",
            "autoIndexFileThreshold", "autoIndexDebounceMs", "autoIndexMaxWaitMs",
        ],
    },
    {
        id: "advanced-conversation",
        tier: "advanced",
        titleKey: "settings.category.conversation",
        itemKeys: ["enableLongTermMemory", "memoryTopK", "memoryMaxItems", "maxConversationMessages"],
    },
    {
        id: "advanced-exam",
        tier: "advanced",
        titleKey: "settings.exam.heading",
        itemKeys: ["examExcludePathPatterns", "enableExamSmartFiltering"],
    },
    {
        id: "advanced-semantic-graph",
        tier: "advanced",
        titleKey: "settings.category.semanticGraph",
        itemKeys: [
            "enableSemanticGraph", "enableSemanticGraphAutoSync", "semanticGraphIncludeLargeFiles",
            "semanticGraphMaxSectionsPerRun", "semanticGraphMaxSectionCharacters",
            "semanticGraphSimilarityTopK", "semanticGraphSimilarityThreshold",
        ],
    },
    {
        id: "advanced-learning-map",
        tier: "advanced",
        titleKey: "settings.category.learningMap",
        itemKeys: [
            "learningMapAutoRelationsEnabled", "learningMapAutoModelThreshold",
            "learningMapAutoIncludeRuleRelations", "learningMapAutoIncludeSimilarityRelations",
        ],
    },
];

export function getSettingsCategories(tier: SettingsTier): readonly SettingsCategoryDefinition[] {
    return SETTINGS_CATEGORIES.filter((category) => category.tier === tier);
}

const ADVANCED_SETTING_KEYS: ReadonlyArray<keyof VaultCoachSettings> = [
    "retrievalPreference", "embeddingProvider", "embeddingModel", "cloudEmbeddingBaseUrl",
    "cloudEmbeddingModel", "chunkSize", "chunkOverlap", "keywordSearchTopK", "vectorSearchTopK",
    "hybridSearchTopK", "rerankTopK", "contextTopK", "answerSourceLimit", "enableQueryRewrite",
    "enableVectorRetrieval", "enableRerank", "generationTemperature", "enableAutoIndexSync",
    "autoIndexDebounceMs", "autoIndexMaxWaitMs", "autoIndexFileThreshold", "enableLongTermMemory",
    "memoryTopK", "memoryMaxItems", "maxConversationMessages", "maxPdfFileSizeMb", "maxPdfPageCount",
    "rerankBaseUrl", "rerankModel", "examExcludePathPatterns", "enableExamSmartFiltering",
    "enableSemanticGraph", "enableSemanticGraphAutoSync", "semanticGraphIncludeLargeFiles",
    "semanticGraphMaxSectionsPerRun", "semanticGraphMaxSectionCharacters", "semanticGraphSimilarityTopK",
    "semanticGraphSimilarityThreshold", "learningMapAutoRelationsEnabled", "learningMapAutoModelThreshold",
    "learningMapAutoIncludeRuleRelations", "learningMapAutoIncludeSimilarityRelations",
];

/** 计算折叠状态下可显示的高级配置摘要，不包含任何配置值。 */
export function getAdvancedSettingsSummary(settings: VaultCoachSettings): { customized: boolean; customizedCount: number } {
    const defaults = createDefaultSettings();
    const customizedCount = ADVANCED_SETTING_KEYS.filter((key) => settings[key] !== defaults[key]).length;
    return { customized: customizedCount > 0, customizedCount };
}
