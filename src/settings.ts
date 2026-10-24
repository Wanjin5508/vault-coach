/**
 * 设置模块。
 *
 * 定义默认设置值和 Obsidian 设置页 UI。设置页只负责读取/写入配置与触发必要的索引失效，
 * 不直接执行检索、模型调用或考试生成逻辑。
 */

import {
    App,
    Notice,
    PluginSettingTab,
    SecretComponent,
    Setting,
    SettingGroup,
    type Plugin,
    type SettingDefinitionItem,
    type SettingGroupItem,
} from "obsidian";
import {
    DEFAULT_AUTO_INDEX_DEBOUNCE_MS,
    DEFAULT_AUTO_INDEX_FILE_THRESHOLD,
    DEFAULT_AUTO_INDEX_MAX_WAIT_MS,
    DEFAULT_CHAT_MODEL,
    DEFAULT_CHUNK_OVERLAP,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CONTEXT_TOP_K,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_GENERATION_TEMPERATURE,
    DEFAULT_HYBRID_TOP_K,
    DEFAULT_KEYWORD_TOP_K,
    DEFAULT_CLOUD_BASE_URL,
    DEFAULT_CLOUD_CHAT_MODEL,
    DEFAULT_CLOUD_EMBEDDING_BASE_URL,
    DEFAULT_CLOUD_EMBEDDING_MODEL,
    DEFAULT_MAX_CONVERSATION_MESSAGES,
    DEFAULT_MEMORY_MAX_ITEMS,
    DEFAULT_MEMORY_TOP_K,
    DEFAULT_MAX_PDF_FILE_SIZE_MB,
    DEFAULT_MAX_PDF_PAGE_COUNT,
    DEFAULT_OLLAMA_BASE_URL,
    DEFAULT_RERANK_TOP_K,
    DEFAULT_SOURCE_LIMIT,
    DEFAULT_VECTOR_TOP_K,
} from "./constants"
import { getDefaultGreeting, translate, type TranslationKey } from "./i18n";
import type { VaultCoachPluginApi } from "./presentation/plugin-api";
import type { VaultCoachSettings } from "./app/config/settings-types";
import { createDefaultSettings } from "./app/config/settings-defaults";
import {
    getAdvancedSettingsSummary,
    getSettingsCategories,
    type SettingsItemId,
    type SettingsTier,
} from "./presentation/settings/settings-section-model";
import { KnowledgeScopePickerModal } from "./presentation/settings/knowledge-scope-picker-modal";
import { renderAdvancedDisclosure } from "./presentation/settings/components/advanced-disclosure";
import { getErrorMessage } from "./utils/errors";

export { createDefaultSettings } from "./app/config/settings-defaults";

/**
 * 插件默认设置
 * 当用户第一次安装插件、还没有保存过配置时，就会使用这些默认值。
 */
/**
 * 当前进程内使用的默认设置快照。
 */
export const DEFAULT_SETTINGS: VaultCoachSettings = createDefaultSettings();

/**
 * Obsidian 设置页：Settings -> Community plugins -> VaultCoach。
 */
export class VaultCoachSettingTab extends PluginSettingTab {
    plugin: VaultCoachPluginApi;
    private unsubscribeLocalAiStatus: (() => void) | null = null;

    constructor(app: App, hostPlugin: Plugin, plugin: VaultCoachPluginApi) {
        super(app, hostPlugin);
        this.plugin = plugin;
    }

    /**
     * 获取本地化文案。
     */
    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    /**
     * Obsidian 1.13.0 之前的设置页回退渲染入口。
     */
    display(): void {
        this.renderSettings();
        if (!this.unsubscribeLocalAiStatus) {
            let initializing = true;
            const unsubscribe = this.plugin.subscribeLocalAiStatus(() => {
                if (!initializing) this.refreshDeclarativeSettings();
            });
            initializing = false;
            this.unsubscribeLocalAiStatus = unsubscribe;
        }
    }

    hide(): void {
        this.unsubscribeLocalAiStatus?.();
        this.unsubscribeLocalAiStatus = null;
    }

    /**
     * 面向 Obsidian 1.13.0 及以上版本的声明式设置定义。
     *
     * `display()` 继续作为插件支持的旧 Obsidian 版本兼容路径。每个定义必须与现有命令式设置
     * 保持一致，使设置搜索能够索引全部面向用户的名称。
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        const advancedExpanded = this.plugin.getSettingsUiPreferences().advancedSettingsExpanded;
        const definitions: SettingDefinitionItem[] = [
            this.createHeadingDefinition("settings.title"),
            this.createHeadingDefinition("settings.basic.heading", "settings.basic.desc"),
            ...this.createCategoryDefinitions("basic"),
            this.createAdvancedVisibilityDefinition(),
        ];
        if (advancedExpanded) {
            definitions.push(
                this.createAdvancedContentAnchorDefinition(),
                ...this.createCategoryDefinitions("advanced"),
            );
        }
        return definitions;
    }

    private createCategoryDefinitions(tier: SettingsTier): SettingDefinitionItem[] {
        return getSettingsCategories(tier).map((category) => ({
            type: "group",
            heading: this.t(category.titleKey),
            cls: `vault-coach-settings__category vault-coach-settings__category--${category.id}`,
            items: category.itemKeys
                .map((itemId) => this.createItemDefinition(itemId))
                .filter((item): item is SettingGroupItem => item !== null),
        }));
    }

    private createItemDefinition(itemId: SettingsItemId): SettingGroupItem | null {
        switch (itemId) {
            case "knowledgeScope":
                return this.asGroupItem(this.createKnowledgeScopeDefinition());
            case "semanticStatus":
                return this.asGroupItem(this.createSemanticSearchStatusDefinition());
            case "builtinEmbeddingRuntime":
                return this.plugin.settings.embeddingProvider === "builtin"
                    ? this.asGroupItem(this.createBuiltinEmbeddingRuntimeDefinition())
                    : null;
            case "cloudApiKey":
                return this.plugin.settings.modelProvider === "openai-compatible"
                    ? this.asGroupItem(this.createCloudApiKeyDefinition())
                    : null;
            case "embeddingCloudApiKey":
                return this.plugin.settings.embeddingProvider === "openai-compatible"
                    && this.plugin.settings.modelProvider !== "openai-compatible"
                    ? this.asGroupItem(this.createCloudApiKeyDefinition())
                    : null;
            case "embeddingLocalBaseUrl":
                return this.plugin.settings.embeddingProvider === "ollama"
                    && this.plugin.settings.modelProvider !== "ollama"
                    ? this.asGroupItem(this.createTextDefinition(
                        "llmBaseUrl",
                        "settings.localServiceBaseUrl.name",
                        "settings.localServiceBaseUrl.desc",
                        DEFAULT_OLLAMA_BASE_URL,
                    ))
                    : null;
            case "assistantName":
                return this.asGroupItem(this.createTextDefinition(itemId, "settings.assistantName.name", "settings.assistantName.desc", this.t("settings.assistantName.placeholder")));
            case "defaultGreeting":
                return this.asGroupItem(this.createTextAreaDefinition(itemId, "settings.defaultGreeting.name", "settings.defaultGreeting.desc", this.t("settings.defaultGreeting.placeholder")));
            case "openInRightSidebarOnStartup":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.openOnStartup.name"));
            case "collapseSourcesByDefault":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.collapseSources.name", "settings.collapseSources.desc"));
            case "enableMarkdownIndexing":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.markdownIndexing.name", "settings.markdownIndexing.desc"));
            case "enablePdfIndexing":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.pdfIndexing.name", "settings.pdfIndexing.desc"));
            case "modelProvider":
                return this.asGroupItem(this.createDropdownDefinition(itemId, "settings.model.chatProvider.name", "settings.model.chatProvider.desc", this.createModelProviderOptions()));
            case "llmBaseUrl":
                return this.plugin.settings.modelProvider === "ollama"
                    ? this.asGroupItem(this.createTextDefinition(itemId, "settings.localServiceBaseUrl.name", "settings.localServiceBaseUrl.desc", DEFAULT_OLLAMA_BASE_URL))
                    : null;
            case "chatModel":
                return this.plugin.settings.modelProvider === "ollama"
                    ? this.asGroupItem(this.createTextDefinition(itemId, "settings.localChatModel.name", "settings.localChatModel.desc", DEFAULT_CHAT_MODEL))
                    : null;
            case "cloudBaseUrl":
                return this.plugin.settings.modelProvider === "openai-compatible"
                    ? this.asGroupItem(this.createTextDefinition(itemId, "settings.cloudChatBaseUrl.name", "settings.cloudChatBaseUrl.desc", DEFAULT_CLOUD_BASE_URL))
                    : null;
            case "cloudChatModel":
                return this.plugin.settings.modelProvider === "openai-compatible"
                    ? this.asGroupItem(this.createTextDefinition(itemId, "settings.cloudChatModel.name", "settings.cloudChatModel.desc", DEFAULT_CLOUD_CHAT_MODEL))
                    : null;
            case "embeddingProvider":
                return this.asGroupItem(this.createDropdownDefinition(itemId, "settings.model.embeddingProvider.name", "settings.model.embeddingProvider.desc", this.createEmbeddingProviderOptions()));
            case "embeddingModel":
                return this.plugin.settings.embeddingProvider === "ollama"
                    ? this.asGroupItem(this.createTextDefinition(itemId, "settings.localEmbeddingModel.name", "settings.localEmbeddingModel.desc", DEFAULT_EMBEDDING_MODEL))
                    : null;
            case "cloudEmbeddingBaseUrl":
                return this.plugin.settings.embeddingProvider === "openai-compatible"
                    ? this.asGroupItem(this.createTextDefinition(itemId, "settings.cloudEmbeddingBaseUrl.name", "settings.cloudEmbeddingBaseUrl.desc", DEFAULT_CLOUD_EMBEDDING_BASE_URL))
                    : null;
            case "cloudEmbeddingModel":
                return this.plugin.settings.embeddingProvider === "openai-compatible"
                    ? this.asGroupItem(this.createTextDefinition(itemId, "settings.cloudEmbeddingModel.name", "settings.cloudEmbeddingModel.desc", DEFAULT_CLOUD_EMBEDDING_MODEL))
                    : null;
            case "retrievalPreference":
                return this.asGroupItem(this.createDropdownDefinition(itemId, "settings.defaultRetrievalMode.name", "settings.defaultRetrievalMode.desc", {
                    auto: "Auto",
                    keyword: this.t("view.retrieval.keyword"),
                    vector: this.t("view.retrieval.vector"),
                    hybrid: this.t("view.retrieval.hybrid"),
                }));
            case "enableVectorRetrieval":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.vectorRetrieval.name", "settings.vectorRetrieval.desc"));
            case "enableQueryRewrite":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.queryRewrite.name", "settings.queryRewrite.desc"));
            case "enableRerank":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.rerank.enable.name", "settings.rerank.enable.desc"));
            case "rerankBaseUrl":
                return this.asGroupItem(this.createTextDefinition(itemId, "settings.rerankBaseUrl.name", "settings.rerankBaseUrl.desc", this.t("settings.rerankBaseUrl.placeholder")));
            case "rerankModel":
                return this.asGroupItem(this.createTextDefinition(itemId, "settings.rerankModel.name", "settings.rerankModel.desc", this.t("settings.rerankModel.placeholder")));
            case "keywordSearchTopK":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.keywordTopK.name", "settings.keywordTopK.desc", DEFAULT_KEYWORD_TOP_K));
            case "vectorSearchTopK":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.vectorTopK.name", "settings.vectorTopK.desc", DEFAULT_VECTOR_TOP_K));
            case "hybridSearchTopK":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.hybridTopK.name", "settings.hybridTopK.desc", DEFAULT_HYBRID_TOP_K));
            case "rerankTopK":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.rerankTopK.name", "settings.rerankTopK.desc", DEFAULT_RERANK_TOP_K));
            case "contextTopK":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.contextTopK.name", "settings.contextTopK.desc", DEFAULT_CONTEXT_TOP_K));
            case "answerSourceLimit":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.sourceLimit.name", "settings.sourceLimit.desc", DEFAULT_SOURCE_LIMIT));
            case "generationTemperature":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.temperature.name", "settings.temperature.desc", DEFAULT_GENERATION_TEMPERATURE));
            case "maxPdfFileSizeMb":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.maxPdfFileSize.name", "settings.maxPdfFileSize.desc", DEFAULT_MAX_PDF_FILE_SIZE_MB));
            case "maxPdfPageCount":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.maxPdfPageCount.name", "settings.maxPdfPageCount.desc", DEFAULT_MAX_PDF_PAGE_COUNT));
            case "chunkSize":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.chunkSize.name", "settings.chunkSize.desc", DEFAULT_CHUNK_SIZE));
            case "chunkOverlap":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.chunkOverlap.name", "settings.chunkOverlap.desc", DEFAULT_CHUNK_OVERLAP));
            case "enableAutoIndexSync":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.autoSync.name", "settings.autoSync.desc"));
            case "autoIndexFileThreshold":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.autoSyncThreshold.name", "settings.autoSyncThreshold.desc", DEFAULT_AUTO_INDEX_FILE_THRESHOLD));
            case "autoIndexDebounceMs":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.autoSyncDebounce.name", "settings.autoSyncDebounce.desc", DEFAULT_AUTO_INDEX_DEBOUNCE_MS));
            case "autoIndexMaxWaitMs":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.autoSyncMaxWait.name", "settings.autoSyncMaxWait.desc", DEFAULT_AUTO_INDEX_MAX_WAIT_MS));
            case "enableLongTermMemory":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.memory.enable.name", "settings.memory.enable.desc"));
            case "memoryTopK":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.memory.topK.name", "settings.memory.topK.desc", DEFAULT_MEMORY_TOP_K));
            case "memoryMaxItems":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.memory.maxItems.name", "settings.memory.maxItems.desc", DEFAULT_MEMORY_MAX_ITEMS));
            case "maxConversationMessages":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.memory.maxMessages.name", "settings.memory.maxMessages.desc", DEFAULT_MAX_CONVERSATION_MESSAGES));
            case "examExcludePathPatterns":
                return this.asGroupItem(this.createTextAreaDefinition(itemId, "settings.examExcludePaths.name", "settings.examExcludePaths.desc", this.t("settings.examExcludePaths.placeholder")));
            case "enableExamSmartFiltering":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.examSmartFiltering.name", "settings.examSmartFiltering.desc"));
            case "enableSemanticGraph":
                return this.asGroupItem(this.createRawToggleDefinition(itemId, "Enable semantic concept graph", "Requires an explicit rebuild from the command palette; it is off by default."));
            case "enableSemanticGraphAutoSync":
                return this.asGroupItem(this.createRawToggleDefinition(itemId, "Update after index changes", "When enabled, only changed Sections are queued after a successful index sync."));
            case "semanticGraphIncludeLargeFiles":
                return this.asGroupItem(this.createRawToggleDefinition(itemId, "Include large source files", "Off by default in Lite: large Markdown and PDF sources are skipped for semantic extraction."));
            case "semanticGraphMaxSectionsPerRun":
                return this.asGroupItem(this.createRawNumericDefinition(itemId, "Semantic extraction batch size", "Number of Sections saved per checkpoint during an exhaustive manual rebuild.", 30));
            case "semanticGraphMaxSectionCharacters":
                return this.asGroupItem(this.createRawNumericDefinition(itemId, "Maximum characters per Section window", "Long Sections are split only at Chunk boundaries.", 9000));
            case "semanticGraphSimilarityTopK":
                return this.asGroupItem(this.createRawNumericDefinition(itemId, "Similarity candidates per Concept", "ANN lookups are bounded; the plugin never compares every Concept pair.", 30));
            case "semanticGraphSimilarityThreshold":
                return this.asGroupItem(this.createRawNumericDefinition(itemId, "Similarity threshold", "Only nearby Concept candidates above this cosine threshold are shown.", 0.86));
            case "learningMapAutoRelationsEnabled":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.learningMapAuto.enabled.name", "settings.learningMapAuto.enabled.desc"));
            case "learningMapAutoModelThreshold":
                return this.asGroupItem(this.createNumericTextDefinition(itemId, "settings.learningMapAuto.threshold.name", "settings.learningMapAuto.threshold.desc", 0.95));
            case "learningMapAutoIncludeRuleRelations":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.learningMapAuto.rules.name", "settings.learningMapAuto.rules.desc"));
            case "learningMapAutoIncludeSimilarityRelations":
                return this.asGroupItem(this.createToggleDefinition(itemId, "settings.learningMapAuto.similarity.name", "settings.learningMapAuto.similarity.desc"));
            case "cloudApiKeySecretName":
            case "knowledgeScopeMode":
            case "knowledgeFolder":
                return null;
        }
    }

    private asGroupItem(definition: SettingDefinitionItem): SettingGroupItem {
        return definition as SettingGroupItem;
    }

    private createAdvancedContentAnchorDefinition(): SettingDefinitionItem {
        return {
            name: this.t("settings.advancedDisclosure.title"),
            searchable: false,
            render: (setting) => {
                setting.settingEl.id = "vault-coach-settings-advanced-content";
                setting.settingEl.addClass("vault-coach-settings__advanced-content-anchor");
                setting.settingEl.empty();
            },
        };
    }

    private createKnowledgeScopeDefinition(): SettingDefinitionItem {
        const selection = this.plugin.getKnowledgeScopeSelection();
        const options = this.plugin.listKnowledgeScopeOptions();
        const currentOption = options.find((option) => option.selected);
        const currentLabel = selection.kind === "whole-vault"
            ? this.t("settings.scope.wholeVault")
            : selection.path || this.t("settings.scopePicker.unset");
        let status = "";
        if (currentOption?.kind === "legacy-folder") {
            status = currentOption.exists
                ? this.t("settings.scopePicker.legacyDesc")
                : this.t("settings.scopePicker.missingDesc");
        }
        const description = [
            this.t("settings.scope.unified.desc"),
            currentLabel,
            status,
        ].filter((part) => part.length > 0).join(" ");

        return {
            name: this.t("settings.scope.unified.name"),
            desc: description,
            aliases: [
                this.t("settings.scope.name"),
                this.t("settings.folder.name"),
                "scope",
                "folder",
                "目录",
            ],
            render: (setting) => {
                setting.addButton((button) => button
                    .setButtonText(selection.kind === "whole-vault"
                        ? this.t("settings.scope.choose")
                        : this.t("settings.scope.change"))
                    .onClick(() => this.openKnowledgeScopePicker()));
            },
        };
    }

    private openKnowledgeScopePicker(): void {
        const modal = new KnowledgeScopePickerModal(
            this.app,
            this.plugin.listKnowledgeScopeOptions(),
            async (selection) => {
                await this.plugin.updateKnowledgeScope(selection);
                this.refreshDeclarativeSettings();
            },
            (error) => {
                new Notice(this.t("settings.scopePicker.saveFailed", { message: getErrorMessage(error) }));
            },
            (key, replacements) => this.t(key, replacements),
        );
        modal.open();
    }

    getControlValue(key: string): unknown {
        const value = this.plugin.settings[key as keyof VaultCoachSettings];
        return typeof value === "number" ? String(value) : value;
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        switch (key) {
            case "assistantName":
                return this.updateAssistantName(value);
            case "defaultGreeting":
                return this.updateDefaultGreeting(value);
            case "openInRightSidebarOnStartup":
            case "collapseSourcesByDefault":
            case "enableAutoIndexSync":
            case "enableLongTermMemory":
            case "enableQueryRewrite":
            case "enableRerank":
                return this.updateBooleanSetting(key, value);
            case "retrievalPreference":
                return this.updateRetrievalPreference(value);
            case "enableMarkdownIndexing":
            case "enablePdfIndexing":
                return this.updateTextIndexSetting(key, value);
            case "maxPdfFileSizeMb":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_MAX_PDF_FILE_SIZE_MB, true);
            case "maxPdfPageCount":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_MAX_PDF_PAGE_COUNT, true);
            case "chunkSize":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_CHUNK_SIZE, true);
            case "chunkOverlap":
                return this.updateNonNegativeIntegerSetting(key, value, DEFAULT_CHUNK_OVERLAP, true);
            case "autoIndexFileThreshold":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_AUTO_INDEX_FILE_THRESHOLD);
            case "autoIndexDebounceMs":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_AUTO_INDEX_DEBOUNCE_MS);
            case "autoIndexMaxWaitMs":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_AUTO_INDEX_MAX_WAIT_MS);
            case "examExcludePathPatterns":
                return this.updateExamExcludePathPatterns(value);
            case "enableExamSmartFiltering":
                return this.updateExamSmartFiltering(value);
            case "enableSemanticGraph":
            case "enableSemanticGraphAutoSync":
            case "semanticGraphIncludeLargeFiles":
                return this.updateSemanticBooleanSetting(key, value);
            case "learningMapAutoRelationsEnabled":
            case "learningMapAutoIncludeRuleRelations":
            case "learningMapAutoIncludeSimilarityRelations":
                return this.updateLearningMapAutoBoolean(key, value);
            case "semanticGraphMaxSectionsPerRun":
            case "semanticGraphMaxSectionCharacters":
            case "semanticGraphSimilarityTopK":
                return this.updateSemanticPositiveIntegerSetting(key, value);
            case "semanticGraphSimilarityThreshold":
                return this.updateSemanticThreshold(value);
            case "learningMapAutoModelThreshold":
                return this.updateLearningMapAutoThreshold(value);
            case "modelProvider":
                return this.updateModelProvider(value);
            case "llmBaseUrl":
                return this.updateLlmBaseUrl(value);
            case "chatModel":
                return this.updateTrimmedTextSetting(key, value, DEFAULT_CHAT_MODEL);
            case "cloudBaseUrl":
                return this.updateTrimmedTextSetting(key, value, DEFAULT_CLOUD_BASE_URL);
            case "cloudChatModel":
                return this.updateTrimmedTextSetting(key, value, DEFAULT_CLOUD_CHAT_MODEL);
            case "embeddingProvider":
                return this.updateEmbeddingProvider(value);
            case "embeddingModel":
                return this.updateEmbeddingTextSetting(key, value, DEFAULT_EMBEDDING_MODEL);
            case "cloudEmbeddingBaseUrl":
                return this.updateEmbeddingTextSetting(key, value, DEFAULT_CLOUD_EMBEDDING_BASE_URL);
            case "cloudEmbeddingModel":
                return this.updateEmbeddingTextSetting(key, value, DEFAULT_CLOUD_EMBEDDING_MODEL);
            case "rerankBaseUrl":
            case "rerankModel":
                return this.updateTrimmedTextSetting(key, value, "");
            case "memoryTopK":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_MEMORY_TOP_K);
            case "memoryMaxItems":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_MEMORY_MAX_ITEMS);
            case "maxConversationMessages":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_MAX_CONVERSATION_MESSAGES);
            case "enableVectorRetrieval":
                return this.updateVectorRetrieval(value);
            case "keywordSearchTopK":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_KEYWORD_TOP_K);
            case "vectorSearchTopK":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_VECTOR_TOP_K);
            case "hybridSearchTopK":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_HYBRID_TOP_K);
            case "rerankTopK":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_RERANK_TOP_K);
            case "contextTopK":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_CONTEXT_TOP_K);
            case "answerSourceLimit":
                return this.updatePositiveIntegerSetting(key, value, DEFAULT_SOURCE_LIMIT);
            case "generationTemperature":
                return this.updateTemperature(value);
            default:
                return;
        }
    }

    private createHeadingDefinition(nameKey: TranslationKey, descKey?: TranslationKey): SettingDefinitionItem {
        return {
            name: this.t(nameKey),
            desc: descKey ? this.t(descKey) : undefined,
            render: (setting) => {
                setting.setHeading();
            },
        };
    }

    private createToggleDefinition(
        key: keyof VaultCoachSettings,
        nameKey: TranslationKey,
        descKey?: TranslationKey,
    ): SettingDefinitionItem {
        return {
            name: this.t(nameKey),
            desc: descKey ? this.t(descKey) : undefined,
            control: { type: "toggle", key },
        };
    }

    private createTextDefinition(
        key: keyof VaultCoachSettings,
        nameKey: TranslationKey,
        descKey?: TranslationKey,
        placeholder?: string,
    ): SettingDefinitionItem {
        return {
            name: this.t(nameKey),
            desc: descKey ? this.t(descKey) : undefined,
            control: { type: "text", key, placeholder },
        };
    }

    private createTextAreaDefinition(
        key: keyof VaultCoachSettings,
        nameKey: TranslationKey,
        descKey?: TranslationKey,
        placeholder?: string,
    ): SettingDefinitionItem {
        return {
            name: this.t(nameKey),
            desc: descKey ? this.t(descKey) : undefined,
            control: { type: "textarea", key, placeholder },
        };
    }

    private createNumericTextDefinition(
        key: keyof VaultCoachSettings,
        nameKey: TranslationKey,
        descKey: TranslationKey,
        fallback: number,
    ): SettingDefinitionItem {
        return this.createTextDefinition(key, nameKey, descKey, String(fallback));
    }

    private createDropdownDefinition(
        key: keyof VaultCoachSettings,
        nameKey: TranslationKey,
        descKey: TranslationKey | undefined,
        options: Record<string, string>,
    ): SettingDefinitionItem {
        return {
            name: this.t(nameKey),
            desc: descKey ? this.t(descKey) : undefined,
            control: { type: "dropdown", key, options },
        };
    }

    private createRawToggleDefinition(key: keyof VaultCoachSettings, name: string, desc: string): SettingDefinitionItem {
        return { name, desc, control: { type: "toggle", key } };
    }

    private createRawNumericDefinition(key: keyof VaultCoachSettings, name: string, desc: string, fallback: number): SettingDefinitionItem {
        return { name, desc, control: { type: "text", key, placeholder: String(fallback) } };
    }

    /** 高级设置展开状态单独持久化，避免把纯 UI 偏好混入运行参数。 */
    private createAdvancedVisibilityDefinition(): SettingDefinitionItem {
        const summary = getAdvancedSettingsSummary(this.plugin.settings);
        const expanded = this.plugin.getSettingsUiPreferences().advancedSettingsExpanded;
        return {
            name: this.t("settings.advancedDisclosure.title"),
            desc: summary.customized
                ? this.t("settings.advancedDisclosure.customized", { count: summary.customizedCount })
                : this.t("settings.advancedDisclosure.desc"),
            aliases: [
                "embedding",
                "检索",
                "retrieval",
                "rerank",
                "索引",
                "index",
                "chunk",
                "记忆",
                "memory",
                "考试",
                "exam",
                "图谱",
                "graph",
            ],
            render: (setting) => {
                return renderAdvancedDisclosure(setting, {
                    expanded,
                    title: this.t("settings.advancedDisclosure.title"),
                    summary: summary.customized
                        ? this.t("settings.advancedDisclosure.customized", { count: summary.customizedCount })
                        : this.t("settings.advancedDisclosure.desc"),
                    contentId: "vault-coach-settings-advanced-content",
                    expandLabel: this.t("settings.advancedDisclosure.expand"),
                    collapseLabel: this.t("settings.advancedDisclosure.collapse"),
                    onToggle: async (advancedSettingsExpanded) => {
                        await this.plugin.setSettingsUiPreferences({ advancedSettingsExpanded });
                        this.refreshDeclarativeSettings();
                    },
                    onError: (error) => {
                        new Notice(this.t("settings.advancedDisclosure.saveFailed", { message: getErrorMessage(error) }));
                    },
                });
            },
        };
    }

    private createSemanticSearchStatusDefinition(): SettingDefinitionItem {
        const stats = this.plugin.getVectorIndexStats();
        const status = stats.ready
            ? this.t("settings.semanticStatus.ready", { count: stats.vectorCount })
            : this.t("settings.semanticStatus.notReady");
        const privacy = this.plugin.settings.embeddingProvider !== "openai-compatible"
            ? this.t("settings.semanticStatus.local")
            : this.t("settings.semanticStatus.remote");
        return { name: this.t("settings.semanticStatus.name"), desc: `${status} ${privacy}` };
    }

    /** 内置模型只在用户明确点击后下载；状态和缓存操作不写入普通插件设置。 */
    private createBuiltinEmbeddingRuntimeDefinition(): SettingDefinitionItem {
        const status = this.plugin.getLocalAiStatus();
        const phaseKey = `settings.builtinEmbedding.phase.${status.phase}` as TranslationKey;
        const progress = status.progress !== null && status.phase === "downloading"
            ? ` ${Math.round(status.progress * 100)}%`
            : "";
        const detail = status.message ? ` ${status.message}` : "";
        return {
            name: this.t("settings.builtinEmbedding.runtime.name"),
            desc: `${this.t(phaseKey)}${progress}. ${this.t("settings.builtinEmbedding.runtime.desc")}${detail}`,
            render: (setting) => {
                setting.addButton((button) => button
                    .setButtonText(status.phase === "ready"
                        ? this.t("settings.builtinEmbedding.reload")
                        : this.t("settings.builtinEmbedding.prepare"))
                    .setCta()
                    .setDisabled(status.phase === "downloading" || status.phase === "loading" || status.phase === "clearing")
                    .onClick(() => this.prepareBuiltinEmbedding()));
                if (status.cached || status.phase === "ready") {
                    setting.addButton((button) => button
                        .setButtonText(this.t("settings.builtinEmbedding.clear"))
                        .setDestructive()
                        .setDisabled(status.phase === "clearing")
                        .onClick(() => this.clearBuiltinEmbedding()));
                }
            },
        };
    }

    private async prepareBuiltinEmbedding(): Promise<void> {
        const operation = this.plugin.prepareBuiltinEmbedding();
        this.refreshDeclarativeSettings();
        try {
            await operation;
            new Notice(this.t("notice.localAiReady"));
        } catch (error) {
            new Notice(this.t("notice.localAiPrepareFailed", { message: getErrorMessage(error) }), 10_000);
        } finally {
            this.refreshDeclarativeSettings();
        }
    }

    private async clearBuiltinEmbedding(): Promise<void> {
        const operation = this.plugin.clearBuiltinEmbedding();
        this.refreshDeclarativeSettings();
        try {
            await operation;
            new Notice(this.t("notice.localAiCleared"));
        } catch (error) {
            new Notice(this.t("notice.localAiClearFailed", { message: getErrorMessage(error) }), 10_000);
        } finally {
            this.refreshDeclarativeSettings();
        }
    }

    private createCloudApiKeyDefinition(): SettingDefinitionItem {
        const needsAttention = this.plugin.settings.cloudApiKeySecretName.length > 0 && !this.plugin.hasCloudApiKeySecret();
        return {
            name: this.t("settings.cloudApiKey.name"),
            desc: needsAttention
                ? `${this.t("settings.cloudApiKey.desc")} Needs attention: the selected secret is unavailable on this device.`
                : this.t("settings.cloudApiKey.desc"),
            render: (setting) => {
                setting.addComponent((containerEl) => new SecretComponent(this.app, containerEl)
                    .setValue(this.plugin.settings.cloudApiKeySecretName)
                    .onChange((value: string) => {
                        void this.updateCloudApiKeySecretName(value);
                    }));
            },
        };
    }

    private createModelProviderOptions(): Record<string, string> {
        return {
            ollama: this.t("settings.model.localOllama"),
            "openai-compatible": this.t("settings.model.openAICompatible"),
        };
    }

    private createEmbeddingProviderOptions(): Record<string, string> {
        return {
            builtin: this.t("settings.model.builtinEmbedding"),
            ...this.createModelProviderOptions(),
        };
    }

    private async updateAssistantName(value: unknown): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings.assistantName = text.trim() || "VaultCoach";
        await this.plugin.saveSettings();
        this.plugin.refreshAllViews();
    }

    private async updateDefaultGreeting(value: unknown): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings.defaultGreeting = text.trim() || getDefaultGreeting();
        await this.plugin.saveSettings();
    }

    private async updateBooleanSetting(
        key: "openInRightSidebarOnStartup" | "collapseSourcesByDefault" | "enableAutoIndexSync" | "enableLongTermMemory" | "enableQueryRewrite" | "enableRerank",
        value: unknown,
    ): Promise<void> {
        const enabled = this.getBooleanValue(value);
        if (enabled === null) return;
        this.plugin.settings[key] = enabled;
        await this.plugin.saveSettings();
    }

    private async updateRetrievalPreference(value: unknown): Promise<void> {
        if (value !== "auto" && value !== "keyword" && value !== "vector" && value !== "hybrid") return;
        this.plugin.settings.retrievalPreference = value;
        this.plugin.settings.defaultRetrievalMode = value === "auto" ? "hybrid" : value;
        this.plugin.setRuntimeRetrievalPreference(value);
        await this.plugin.saveSettings();
        this.plugin.refreshAllViews();
    }

    private async updateTextIndexSetting(
        key: "enableMarkdownIndexing" | "enablePdfIndexing",
        value: unknown,
    ): Promise<void> {
        const enabled = this.getBooleanValue(value);
        if (enabled === null) return;
        this.plugin.settings[key] = enabled;
        await this.plugin.saveSettings();
        this.plugin.markKnowledgeBaseDirty();
    }

    private async updatePositiveIntegerSetting(
        key: "maxPdfFileSizeMb" | "maxPdfPageCount" | "chunkSize" | "autoIndexFileThreshold" | "autoIndexDebounceMs" | "autoIndexMaxWaitMs" | "memoryTopK" | "memoryMaxItems" | "maxConversationMessages" | "keywordSearchTopK" | "vectorSearchTopK" | "hybridSearchTopK" | "rerankTopK" | "contextTopK" | "answerSourceLimit",
        value: unknown,
        fallback: number,
        marksTextIndexDirty = false,
    ): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings[key] = this.parsePositiveInteger(text, fallback);
        await this.plugin.saveSettings();
        if (marksTextIndexDirty) this.plugin.markKnowledgeBaseDirty();
    }

    private async updateNonNegativeIntegerSetting(
        key: "chunkOverlap",
        value: unknown,
        fallback: number,
        marksTextIndexDirty = false,
    ): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings[key] = this.parseNonNegativeInteger(text, fallback);
        await this.plugin.saveSettings();
        if (marksTextIndexDirty) this.plugin.markKnowledgeBaseDirty();
    }

    private async updateExamExcludePathPatterns(value: unknown): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings.examExcludePathPatterns = text;
        await this.plugin.saveSettings();
        this.plugin.refreshAllViews();
    }

    private async updateExamSmartFiltering(value: unknown): Promise<void> {
        const enabled = this.getBooleanValue(value);
        if (enabled === null) return;
        this.plugin.settings.enableExamSmartFiltering = enabled;
        await this.plugin.saveSettings();
        this.plugin.refreshAllViews();
    }

    private async updateSemanticBooleanSetting(
        key: "enableSemanticGraph" | "enableSemanticGraphAutoSync" | "semanticGraphIncludeLargeFiles",
        value: unknown,
    ): Promise<void> {
        const enabled = this.getBooleanValue(value);
        if (enabled === null) return;
        this.plugin.settings[key] = enabled;
        await this.plugin.saveSettings();
    }

    private async updateSemanticPositiveIntegerSetting(
        key: "semanticGraphMaxSectionsPerRun" | "semanticGraphMaxSectionCharacters" | "semanticGraphSimilarityTopK",
        value: unknown,
    ): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        const fallback = key === "semanticGraphMaxSectionsPerRun" ? 30 : key === "semanticGraphMaxSectionCharacters" ? 9000 : 30;
        this.plugin.settings[key] = this.parsePositiveInteger(text, fallback);
        await this.plugin.saveSettings();
    }

    private async updateSemanticThreshold(value: unknown): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        const parsed = Number.parseFloat(text);
        this.plugin.settings.semanticGraphSimilarityThreshold = Number.isFinite(parsed)
            ? Math.min(1, Math.max(0, parsed))
            : 0.86;
        await this.plugin.saveSettings();
    }

    private async updateLearningMapAutoBoolean(
        key: "learningMapAutoRelationsEnabled" | "learningMapAutoIncludeRuleRelations" | "learningMapAutoIncludeSimilarityRelations",
        value: unknown,
    ): Promise<void> {
        const enabled = this.getBooleanValue(value);
        if (enabled === null) return;
        this.plugin.settings[key] = enabled;
        await this.plugin.saveSettings();
        this.plugin.refreshAllViews();
    }

    private async updateLearningMapAutoThreshold(value: unknown): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        const parsed = Number.parseFloat(text);
        this.plugin.settings.learningMapAutoModelThreshold = Number.isFinite(parsed)
            ? Math.min(1, Math.max(0.7, parsed))
            : 0.95;
        await this.plugin.saveSettings();
        this.plugin.refreshAllViews();
    }

    private async updateModelProvider(value: unknown): Promise<void> {
        if (value !== "ollama" && value !== "openai-compatible") return;
        this.plugin.settings.modelProvider = value;
        await this.plugin.saveSettings();
        this.refreshDeclarativeSettings();
    }

    private async updateLlmBaseUrl(value: unknown): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings.llmBaseUrl = text.trim() || DEFAULT_OLLAMA_BASE_URL;
        await this.plugin.saveSettings();
        if (this.plugin.settings.embeddingProvider === "ollama") {
            this.plugin.markVectorIndexDirty();
        }
    }

    private async updateTrimmedTextSetting(
        key: "chatModel" | "cloudBaseUrl" | "cloudChatModel" | "rerankBaseUrl" | "rerankModel",
        value: unknown,
        fallback: string,
    ): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings[key] = text.trim() || fallback;
        await this.plugin.saveSettings();
    }

    private async updateEmbeddingProvider(value: unknown): Promise<void> {
        if (value !== "ollama" && value !== "openai-compatible" && value !== "builtin") return;
        this.plugin.settings.embeddingProvider = value;
        await this.plugin.saveSettings();
        this.plugin.markVectorIndexDirty();
        this.refreshDeclarativeSettings();
    }

    private async updateEmbeddingTextSetting(
        key: "embeddingModel" | "cloudEmbeddingBaseUrl" | "cloudEmbeddingModel",
        value: unknown,
        fallback: string,
    ): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings[key] = text.trim() || fallback;
        await this.plugin.saveSettings();
        this.plugin.markVectorIndexDirty();
    }

    private async updateCloudApiKeySecretName(value: string): Promise<void> {
        this.plugin.settings.cloudApiKeySecretName = value;
        await this.plugin.saveSettings();
    }

    private async updateVectorRetrieval(value: unknown): Promise<void> {
        const enabled = this.getBooleanValue(value);
        if (enabled === null) return;
        this.plugin.settings.enableVectorRetrieval = enabled;
        await this.plugin.saveSettings();
        this.plugin.markVectorIndexDirty();
    }

    private async updateTemperature(value: unknown): Promise<void> {
        const text = this.getStringValue(value);
        if (text === null) return;
        this.plugin.settings.generationTemperature = this.parseTemperature(text, DEFAULT_GENERATION_TEMPERATURE);
        await this.plugin.saveSettings();
    }

    private getStringValue(value: unknown): string | null {
        return typeof value === "string" ? value : null;
    }

    private getBooleanValue(value: unknown): boolean | null {
        return typeof value === "boolean" ? value : null;
    }

    /**
     * 在 Obsidian 1.13 及以上版本刷新依赖 provider 的定义，
     * 同时不要求旧安装提供较新的 `SettingTab.update()` API。
     */
    private refreshDeclarativeSettings(): void {
        const settingTab = this as unknown as Record<string, unknown>;
        const update = settingTab["update"];
        if (typeof update === "function") {
            update.call(this);
            return;
        }

        this.renderSettings();
    }

    /**
     * 渲染设置页根结构和所有分区。
     */
    private renderSettings(): void {
        const { containerEl } = this;
        containerEl.empty();
        this.renderDefinitionItems(containerEl, this.getSettingDefinitions());
    }

    /**
     * 在 Obsidian 1.11.4 至 1.12.x 中解释 1.13 声明式定义。
     *
     * 两条渲染路径共用同一注册表和字段定义，避免设置顺序、可见条件或保存回调发生漂移。
     */
    private renderDefinitionItems(containerEl: HTMLElement, definitions: SettingDefinitionItem[]): void {
        for (const definition of definitions) {
            if ("type" in definition && (definition.type === "group" || definition.type === "list")) {
                if (!this.isDefinitionVisible(definition.visible)) continue;
                const group = new SettingGroup(containerEl);
                if (definition.heading) group.setHeading(definition.heading);
                for (const cls of definition.cls?.split(/\s+/).filter(Boolean) ?? []) group.addClass(cls);
                for (const [index, item] of (definition.items ?? []).entries()) {
                    if (!this.isDefinitionVisible(item.visible)) continue;
                    group.addSetting((setting) => this.renderDefinitionItem(setting, item, group, index));
                }
                continue;
            }

            if ("type" in definition && definition.type === "page") continue;
            if (!this.isDefinitionVisible(definition.visible)) continue;
            const setting = new Setting(containerEl);
            this.renderDefinitionItem(setting, definition as SettingGroupItem, undefined, 0);
        }
    }

    private renderDefinitionItem(
        setting: Setting,
        definition: SettingGroupItem,
        group: SettingGroup | undefined,
        index: number,
    ): void {
        if ("type" in definition && definition.type === "page") return;
        setting.setName(definition.name);
        if (definition.desc) setting.setDesc(definition.desc);

        if ("render" in definition && typeof definition.render === "function") {
            definition.render(setting, group as SettingGroup);
            return;
        }
        if ("action" in definition && typeof definition.action === "function") {
            setting.addButton((button) => button
                .setButtonText(definition.name)
                .onClick(() => definition.action(index)));
            return;
        }
        if (!("control" in definition) || !definition.control) return;

        const control = definition.control;
        const value = this.getControlValue(control.key);
        const disabled = typeof control.disabled === "function" ? control.disabled() : control.disabled === true;
        switch (control.type) {
            case "toggle":
                setting.addToggle((component) => component
                    .setValue(typeof value === "boolean" ? value : false)
                    .setDisabled(disabled)
                    .onChange((nextValue) => { void this.setControlValue(control.key, nextValue); }));
                break;
            case "dropdown":
                setting.addDropdown((component) => {
                    for (const [optionValue, label] of Object.entries(control.options)) {
                        component.addOption(optionValue, label);
                    }
                    component
                        .setValue(typeof value === "string" ? value : "")
                        .setDisabled(disabled)
                        .onChange((nextValue) => { void this.setControlValue(control.key, nextValue); });
                });
                break;
            case "text":
            case "number":
            case "file":
            case "folder":
                setting.addText((component) => component
                    .setPlaceholder(control.placeholder ?? "")
                    .setValue(typeof value === "string" || typeof value === "number" ? `${value}` : "")
                    .setDisabled(disabled)
                    .onChange((nextValue) => { void this.setControlValue(control.key, nextValue); }));
                break;
            case "textarea":
                setting.addTextArea((component) => component
                    .setPlaceholder(control.placeholder ?? "")
                    .setValue(typeof value === "string" || typeof value === "number" ? `${value}` : "")
                    .setDisabled(disabled)
                    .onChange((nextValue) => { void this.setControlValue(control.key, nextValue); }));
                break;
            default:
                break;
        }
    }

    private isDefinitionVisible(visible: boolean | (() => boolean) | undefined): boolean {
        return typeof visible === "function" ? visible() : visible !== false;
    }

    private parsePositiveInteger(value: string, fallback: number): number {
        const parsed: number = Number.parseInt(value.trim(), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback;
        }
        return parsed;
    }

    /**
     * 解析非负整数。
     */
    private parseNonNegativeInteger(value: string, fallback: number): number {
        const parsed: number = Number.parseInt(value.trim(), 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return fallback;
        }
        return parsed;
    }

    /**
     * 解析 temperature。
     */
    private parseTemperature(value: string, fallback: number): number {
        const parsed: number = Number.parseFloat(value.trim());
        if (!Number.isFinite(parsed) || parsed < 0) {
            return fallback;
        }
        return parsed;
    }

}
