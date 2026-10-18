import { createDefaultSettings } from "../../app/config/settings-defaults";
import type { VaultCoachSettings } from "../../app/config/settings-types";

const ADVANCED_SETTING_KEYS: ReadonlyArray<keyof VaultCoachSettings> = [
    "retrievalPreference", "embeddingProvider", "embeddingModel", "cloudEmbeddingBaseUrl",
    "cloudEmbeddingModel", "chunkSize", "chunkOverlap", "keywordSearchTopK", "vectorSearchTopK",
    "hybridSearchTopK", "rerankTopK", "contextTopK", "answerSourceLimit", "enableQueryRewrite",
    "enableVectorRetrieval", "enableRerank", "generationTemperature", "enableAutoIndexSync",
    "autoIndexDebounceMs", "autoIndexMaxWaitMs", "autoIndexFileThreshold", "enableLongTermMemory",
    "memoryTopK", "memoryMaxItems", "maxConversationMessages",
];

/** 计算折叠状态下可显示的高级配置摘要，不包含任何配置值。 */
export function getAdvancedSettingsSummary(settings: VaultCoachSettings): { customized: boolean; customizedCount: number } {
    const defaults = createDefaultSettings();
    const customizedCount = ADVANCED_SETTING_KEYS.filter((key) => settings[key] !== defaults[key]).length;
    return { customized: customizedCount > 0, customizedCount };
}
