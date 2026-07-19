/**
 * 设置模块。
 *
 * 定义默认设置值和 Obsidian 设置页 UI。设置页只负责读取/写入配置与触发必要的索引失效，
 * 不直接执行检索、模型调用或考试生成逻辑。
 */

import { App, DropdownComponent, PluginSettingTab, SecretComponent, Setting, normalizePath, type Plugin } from "obsidian";
import {
    DEFAULT_AUTO_INDEX_DEBOUNCE_MS,
    DEFAULT_AUTO_INDEX_FILE_THRESHOLD,
    DEFAULT_AUTO_INDEX_MAX_WAIT_MS,
    DEFAULT_CHAT_MODEL,
    DEFAULT_CHUNK_OVERLAP,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CONTEXT_TOP_K,
    DEFAULT_ENABLE_MARKDOWN_INDEXING,
    DEFAULT_ENABLE_PDF_INDEXING,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_ENABLE_AUTO_INDEX_SYNC,
    DEFAULT_ENABLE_LONG_TERM_MEMORY,
    DEFAULT_GENERATION_TEMPERATURE,
    DEFAULT_HYBRID_TOP_K,
    DEFAULT_KEYWORD_TOP_K,
    DEFAULT_CLOUD_BASE_URL,
    DEFAULT_CLOUD_CHAT_MODEL,
    DEFAULT_CLOUD_EMBEDDING_BASE_URL,
    DEFAULT_CLOUD_EMBEDDING_MODEL,
    DEFAULT_EMBEDDING_PROVIDER,
    DEFAULT_MAX_CONVERSATION_MESSAGES,
    DEFAULT_MEMORY_MAX_ITEMS,
    DEFAULT_MEMORY_TOP_K,
    DEFAULT_MODEL_PROVIDER,
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

/**
 * 插件默认设置
 * 当用户第一次安装插件、还没有保存过配置时，就会使用这些默认值。
 */
export function createDefaultSettings(): VaultCoachSettings {
    return {
        enableMarkdownIndexing: DEFAULT_ENABLE_MARKDOWN_INDEXING,
        enablePdfIndexing: DEFAULT_ENABLE_PDF_INDEXING,
        maxPdfFileSizeMb: DEFAULT_MAX_PDF_FILE_SIZE_MB,
        maxPdfPageCount: DEFAULT_MAX_PDF_PAGE_COUNT,
        assistantName: "VaultCoach",
        defaultGreeting: getDefaultGreeting(),
        openInRightSidebarOnStartup: true,
        knowledgeScopeMode: "wholeVault",
        knowledgeFolder: "",
        chunkSize: DEFAULT_CHUNK_SIZE,
        chunkOverlap: DEFAULT_CHUNK_OVERLAP,
        keywordSearchTopK: DEFAULT_KEYWORD_TOP_K,
        vectorSearchTopK: DEFAULT_VECTOR_TOP_K,
        hybridSearchTopK: DEFAULT_HYBRID_TOP_K,
        rerankTopK: DEFAULT_RERANK_TOP_K,
        contextTopK: DEFAULT_CONTEXT_TOP_K,
        answerSourceLimit: DEFAULT_SOURCE_LIMIT,
        collapseSourcesByDefault: true,
        defaultRetrievalMode: "hybrid",
        enableQueryRewrite: true,
        enableVectorRetrieval: true,
        enableRerank: true,
        generationTemperature: DEFAULT_GENERATION_TEMPERATURE,
        modelProvider: DEFAULT_MODEL_PROVIDER,
        llmBaseUrl: DEFAULT_OLLAMA_BASE_URL,
        chatModel: DEFAULT_CHAT_MODEL,
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
        embeddingProvider: DEFAULT_EMBEDDING_PROVIDER,
        cloudEmbeddingBaseUrl: DEFAULT_CLOUD_EMBEDDING_BASE_URL,
        cloudEmbeddingModel: DEFAULT_CLOUD_EMBEDDING_MODEL,
        cloudBaseUrl: DEFAULT_CLOUD_BASE_URL,
        cloudChatModel: DEFAULT_CLOUD_CHAT_MODEL,
        cloudApiKeySecretName: "",
        rerankBaseUrl: "",
        rerankModel: "",
        enableLongTermMemory: DEFAULT_ENABLE_LONG_TERM_MEMORY,
        memoryTopK: DEFAULT_MEMORY_TOP_K,
        memoryMaxItems: DEFAULT_MEMORY_MAX_ITEMS,
        maxConversationMessages: DEFAULT_MAX_CONVERSATION_MESSAGES,
        enableAutoIndexSync: DEFAULT_ENABLE_AUTO_INDEX_SYNC,
        autoIndexDebounceMs: DEFAULT_AUTO_INDEX_DEBOUNCE_MS,
        autoIndexMaxWaitMs: DEFAULT_AUTO_INDEX_MAX_WAIT_MS,
        autoIndexFileThreshold: DEFAULT_AUTO_INDEX_FILE_THRESHOLD,
        examExcludePathPatterns: "",
        enableExamSmartFiltering: true,
    };
}

/**
 * 当前进程内使用的默认设置快照。
 */
export const DEFAULT_SETTINGS: VaultCoachSettings = createDefaultSettings();

/**
 * Obsidian 设置页：Settings -> Community plugins -> VaultCoach。
 */
export class VaultCoachSettingTab extends PluginSettingTab {
    plugin: VaultCoachPluginApi;

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
     * Obsidian 每次打开设置页时调用，用于渲染完整设置界面。
     */
    display(): void {
        this.renderSettings();
    }

    /**
     * 渲染设置页根结构和所有分区。
     */
    private renderSettings(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setHeading()
            .setName(this.t("settings.title"));

        this.renderGeneralSection(containerEl);
        this.renderKnowledgeSection(containerEl);
        this.renderExamSection(containerEl);
        this.renderModelSection(containerEl);
        this.renderMemorySection(containerEl);
        this.renderAdvancedRagSection(containerEl);
    }

    /**
     * 基础显示与行为设置。
     */
    private renderGeneralSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName(this.t("settings.general.heading"))
            .setDesc(this.t("settings.general.desc"));

        new Setting(containerEl)
            .setName(this.t("settings.assistantName.name"))
            .setDesc(this.t("settings.assistantName.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(this.t("settings.assistantName.placeholder"))
                    .setValue(this.plugin.settings.assistantName)
                    .onChange(async (value: string) => {
                        this.plugin.settings.assistantName = value.trim() || "VaultCoach";
                        await this.plugin.saveSettings();
                        this.plugin.refreshAllViews();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.defaultGreeting.name"))
            .setDesc(this.t("settings.defaultGreeting.desc"))
            .addTextArea((text) =>
                text
                    .setPlaceholder(this.t("settings.defaultGreeting.placeholder"))
                    .setValue(this.plugin.getEffectiveDefaultGreeting())
                    .onChange(async (value: string) => {
                        this.plugin.settings.defaultGreeting = value.trim() || getDefaultGreeting();
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.openOnStartup.name"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.openInRightSidebarOnStartup)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.openInRightSidebarOnStartup = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.defaultRetrievalMode.name"))
            .setDesc(this.t("settings.defaultRetrievalMode.desc"))
            .addDropdown((dropdown) => {
                this.addRetrievalModeOptions(dropdown);
                dropdown
                    .setValue(this.plugin.settings.defaultRetrievalMode)
                    .onChange(async (value: string) => {
                        if (value !== "keyword" && value !== "vector" && value !== "hybrid") {
                            return;
                        }
                        this.plugin.settings.defaultRetrievalMode = value;
                        this.plugin.setRuntimeRetrievalMode(value);
                        await this.plugin.saveSettings();
                        this.plugin.refreshAllViews();
                    });
            });

        new Setting(containerEl)
            .setName(this.t("settings.collapseSources.name"))
            .setDesc(this.t("settings.collapseSources.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.collapseSourcesByDefault)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.collapseSourcesByDefault = value;
                        await this.plugin.saveSettings();
                    }),
            );
    }

    /**
     * 知识库索引与 chunk 参数。
     */
    private renderKnowledgeSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName(this.t("settings.knowledge.heading"))
            .setDesc(this.t("settings.knowledge.desc"));

        new Setting(containerEl)
            .setName(this.t("settings.scope.name"))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("wholeVault", this.t("settings.scope.wholeVault"))
                    .addOption("specificFolder", this.t("settings.scope.specificFolder"))
                    .setValue(this.plugin.settings.knowledgeScopeMode)
                    .onChange(async (value: string) => {
                        if (value !== "wholeVault" && value !== "specificFolder") {
                            return;
                        }
                        this.plugin.settings.knowledgeScopeMode = value;
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.folder.name"))
            .setDesc(this.t("settings.folder.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(this.t("settings.folder.placeholder"))
                    .setValue(this.plugin.settings.knowledgeFolder)
                    .onChange(async (value: string) => {
                        this.plugin.settings.knowledgeFolder = this.normalizeFolderPath(value);
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.markdownIndexing.name"))
            .setDesc(this.t("settings.markdownIndexing.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableMarkdownIndexing)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableMarkdownIndexing = value;
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.pdfIndexing.name"))
            .setDesc(this.t("settings.pdfIndexing.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enablePdfIndexing)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enablePdfIndexing = value;
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.maxPdfFileSize.name"))
            .setDesc(this.t("settings.maxPdfFileSize.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_MAX_PDF_FILE_SIZE_MB))
                    .setValue(String(this.plugin.settings.maxPdfFileSizeMb))
                    .onChange(async (value: string) => {
                        this.plugin.settings.maxPdfFileSizeMb = this.parsePositiveInteger(value, DEFAULT_MAX_PDF_FILE_SIZE_MB);
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.maxPdfPageCount.name"))
            .setDesc(this.t("settings.maxPdfPageCount.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_MAX_PDF_PAGE_COUNT))
                    .setValue(String(this.plugin.settings.maxPdfPageCount))
                    .onChange(async (value: string) => {
                        this.plugin.settings.maxPdfPageCount = this.parsePositiveInteger(value, DEFAULT_MAX_PDF_PAGE_COUNT);
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.chunkSize.name"))
            .setDesc(this.t("settings.chunkSize.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_CHUNK_SIZE))
                    .setValue(String(this.plugin.settings.chunkSize))
                    .onChange(async (value: string) => {
                        const parsed: number = this.parsePositiveInteger(value, DEFAULT_CHUNK_SIZE);
                        this.plugin.settings.chunkSize = parsed;
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.chunkOverlap.name"))
            .setDesc(this.t("settings.chunkOverlap.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_CHUNK_OVERLAP))
                    .setValue(String(this.plugin.settings.chunkOverlap))
                    .onChange(async (value: string) => {
                        const parsed: number = this.parseNonNegativeInteger(value, DEFAULT_CHUNK_OVERLAP);
                        this.plugin.settings.chunkOverlap = parsed;
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        // 自动增量同步相关设置。
        new Setting(containerEl)
            .setName(this.t("settings.autoSync.name"))
            .setDesc(this.t("settings.autoSync.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableAutoIndexSync)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableAutoIndexSync = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.autoSyncThreshold.name"))
            .setDesc(this.t("settings.autoSyncThreshold.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_AUTO_INDEX_FILE_THRESHOLD))
                    .setValue(String(this.plugin.settings.autoIndexFileThreshold))
                    .onChange(async (value: string) => {
                        this.plugin.settings.autoIndexFileThreshold = this.parsePositiveInteger(value, DEFAULT_AUTO_INDEX_FILE_THRESHOLD);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.autoSyncDebounce.name"))
            .setDesc(this.t("settings.autoSyncDebounce.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_AUTO_INDEX_DEBOUNCE_MS))
                    .setValue(String(this.plugin.settings.autoIndexDebounceMs))
                    .onChange(async (value: string) => {
                        this.plugin.settings.autoIndexDebounceMs = this.parsePositiveInteger(value, DEFAULT_AUTO_INDEX_DEBOUNCE_MS);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.autoSyncMaxWait.name"))
            .setDesc(this.t("settings.autoSyncMaxWait.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_AUTO_INDEX_MAX_WAIT_MS))
                    .setValue(String(this.plugin.settings.autoIndexMaxWaitMs))
                    .onChange(async (value: string) => {
                        this.plugin.settings.autoIndexMaxWaitMs = this.parsePositiveInteger(value, DEFAULT_AUTO_INDEX_MAX_WAIT_MS);
                        await this.plugin.saveSettings();
                    }),
            );

    }

    /**
     * 考试模式设置。
     */
    private renderExamSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName(this.t("settings.exam.heading"))
            .setDesc(this.t("settings.exam.desc"));

        new Setting(containerEl)
            .setName(this.t("settings.examExcludePaths.name"))
            .setDesc(this.t("settings.examExcludePaths.desc"))
            .addTextArea((text) =>
                text
                    .setPlaceholder(this.t("settings.examExcludePaths.placeholder"))
                    .setValue(this.plugin.settings.examExcludePathPatterns)
                    .onChange(async (value: string) => {
                        this.plugin.settings.examExcludePathPatterns = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshAllViews();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.examSmartFiltering.name"))
            .setDesc(this.t("settings.examSmartFiltering.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableExamSmartFiltering)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableExamSmartFiltering = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshAllViews();
                    }),
            );
    }

    /**
     * 长期记忆与对话持久化设置。
     */
    private renderMemorySection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName(this.t("settings.memory.heading"));

        new Setting(containerEl)
            .setName(this.t("settings.memory.enable.name"))
            .setDesc(this.t("settings.memory.enable.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableLongTermMemory)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableLongTermMemory = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.memory.topK.name"))
            .setDesc(this.t("settings.memory.topK.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_MEMORY_TOP_K))
                    .setValue(String(this.plugin.settings.memoryTopK))
                    .onChange(async (value: string) => {
                        this.plugin.settings.memoryTopK = this.parsePositiveInteger(value, DEFAULT_MEMORY_TOP_K);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.memory.maxItems.name"))
            .setDesc(this.t("settings.memory.maxItems.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_MEMORY_MAX_ITEMS))
                    .setValue(String(this.plugin.settings.memoryMaxItems))
                    .onChange(async (value: string) => {
                        this.plugin.settings.memoryMaxItems = this.parsePositiveInteger(value, DEFAULT_MEMORY_MAX_ITEMS);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.memory.maxMessages.name"))
            .setDesc(this.t("settings.memory.maxMessages.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_MAX_CONVERSATION_MESSAGES))
                    .setValue(String(this.plugin.settings.maxConversationMessages))
                    .onChange(async (value: string) => {
                        this.plugin.settings.maxConversationMessages = this.parsePositiveInteger(value, DEFAULT_MAX_CONVERSATION_MESSAGES);
                        await this.plugin.saveSettings();
                    }),
            );
    }

    /**
     * 高级 RAG 检索参数。
     */
    private renderAdvancedRagSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName(this.t("settings.advanced.heading"))
            .setDesc(this.t("settings.advanced.desc"));

        new Setting(containerEl)
            .setName(this.t("settings.queryRewrite.name"))
            .setDesc(this.t("settings.queryRewrite.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableQueryRewrite)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableQueryRewrite = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.vectorRetrieval.name"))
            .setDesc(this.t("settings.vectorRetrieval.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableVectorRetrieval)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableVectorRetrieval = value;
                        await this.plugin.saveSettings();
                        this.plugin.markVectorIndexDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.rerank.enable.name"))
            .setDesc(this.t("settings.rerank.enable.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableRerank)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableRerank = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.keywordTopK.name"))
            .setDesc(this.t("settings.keywordTopK.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_KEYWORD_TOP_K))
                    .setValue(String(this.plugin.settings.keywordSearchTopK))
                    .onChange(async (value: string) => {
                        this.plugin.settings.keywordSearchTopK = this.parsePositiveInteger(value, DEFAULT_KEYWORD_TOP_K);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.vectorTopK.name"))
            .setDesc(this.t("settings.vectorTopK.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_VECTOR_TOP_K))
                    .setValue(String(this.plugin.settings.vectorSearchTopK))
                    .onChange(async (value: string) => {
                        this.plugin.settings.vectorSearchTopK = this.parsePositiveInteger(value, DEFAULT_VECTOR_TOP_K);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.hybridTopK.name"))
            .setDesc(this.t("settings.hybridTopK.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_HYBRID_TOP_K))
                    .setValue(String(this.plugin.settings.hybridSearchTopK))
                    .onChange(async (value: string) => {
                        this.plugin.settings.hybridSearchTopK = this.parsePositiveInteger(value, DEFAULT_HYBRID_TOP_K);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.rerankTopK.name"))
            .setDesc(this.t("settings.rerankTopK.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_RERANK_TOP_K))
                    .setValue(String(this.plugin.settings.rerankTopK))
                    .onChange(async (value: string) => {
                        this.plugin.settings.rerankTopK = this.parsePositiveInteger(value, DEFAULT_RERANK_TOP_K);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.contextTopK.name"))
            .setDesc(this.t("settings.contextTopK.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_CONTEXT_TOP_K))
                    .setValue(String(this.plugin.settings.contextTopK))
                    .onChange(async (value: string) => {
                        this.plugin.settings.contextTopK = this.parsePositiveInteger(value, DEFAULT_CONTEXT_TOP_K);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.sourceLimit.name"))
            .setDesc(this.t("settings.sourceLimit.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_SOURCE_LIMIT))
                    .setValue(String(this.plugin.settings.answerSourceLimit))
                    .onChange(async (value: string) => {
                        this.plugin.settings.answerSourceLimit = this.parsePositiveInteger(value, DEFAULT_SOURCE_LIMIT);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.temperature.name"))
            .setDesc(this.t("settings.temperature.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_GENERATION_TEMPERATURE))
                    .setValue(String(this.plugin.settings.generationTemperature))
                    .onChange(async (value: string) => {
                        this.plugin.settings.generationTemperature = this.parseTemperature(value, DEFAULT_GENERATION_TEMPERATURE);
                        await this.plugin.saveSettings();
                    }),
            );
    }

    /**
     * 模型服务设置。
     */
    private renderModelSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName(this.t("settings.model.heading"))
            .setDesc(this.t("settings.model.desc"));

        new Setting(containerEl)
            .setName(this.t("settings.model.chatProvider.name"))
            .setDesc(this.t("settings.model.chatProvider.desc"))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("ollama", this.t("settings.model.localOllama"))
                    .addOption("openai-compatible", this.t("settings.model.openAICompatible"))
                    .setValue(this.plugin.settings.modelProvider)
                    .onChange(async (value: string) => {
                        if (value !== "ollama" && value !== "openai-compatible") return;
                        this.plugin.settings.modelProvider = value;
                        await this.plugin.saveSettings();
                        this.renderSettings();
                    }),
            );

        if (this.usesLocalModel()) {
            this.renderLocalServiceAddressSetting(containerEl);
        }

        if (this.plugin.settings.modelProvider === "ollama") {
            this.renderLocalChatSettings(containerEl);
        } else {
            this.renderCloudChatSettings(containerEl);
        }

        new Setting(containerEl)
            .setName(this.t("settings.model.embeddingProvider.name"))
            .setDesc(this.t("settings.model.embeddingProvider.desc"))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("ollama", this.t("settings.model.localOllama"))
                    .addOption("openai-compatible", this.t("settings.model.openAICompatible"))
                    .setValue(this.plugin.settings.embeddingProvider)
                    .onChange(async (value: string) => {
                        if (value !== "ollama" && value !== "openai-compatible") return;
                        this.plugin.settings.embeddingProvider = value;
                        await this.plugin.saveSettings();
                        this.plugin.markVectorIndexDirty();
                        this.renderSettings();
                    }),
            );

        if (this.plugin.settings.embeddingProvider === "ollama") {
            this.renderLocalEmbeddingSettings(containerEl);
        } else {
            this.renderCloudEmbeddingSettings(containerEl);
        }

        if (this.usesCloudModel()) {
            this.renderCloudApiKeySetting(containerEl);
        }

        this.renderRerankSettings(containerEl);
    }

    /**
     * 本地聊天模型设置。
     */
    private renderLocalChatSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(this.t("settings.localChatModel.name"))
            .setDesc(this.t("settings.localChatModel.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_CHAT_MODEL)
                    .setValue(this.plugin.settings.chatModel)
                    .onChange(async (value: string) => {
                        this.plugin.settings.chatModel = value.trim() || DEFAULT_CHAT_MODEL;
                        await this.plugin.saveSettings();
                    }),
            );
    }

    /**
     * 云端聊天模型设置。
     */
    private renderCloudChatSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(this.t("settings.cloudChatBaseUrl.name"))
            .setDesc(this.t("settings.cloudChatBaseUrl.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_CLOUD_BASE_URL)
                    .setValue(this.plugin.settings.cloudBaseUrl)
                    .onChange(async (value: string) => {
                        this.plugin.settings.cloudBaseUrl = value.trim() || DEFAULT_CLOUD_BASE_URL;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.cloudChatModel.name"))
            .setDesc(this.t("settings.cloudChatModel.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_CLOUD_CHAT_MODEL)
                    .setValue(this.plugin.settings.cloudChatModel)
                    .onChange(async (value: string) => {
                        this.plugin.settings.cloudChatModel = value.trim() || DEFAULT_CLOUD_CHAT_MODEL;
                        await this.plugin.saveSettings();
                    }),
            );
    }

    /**
     * 本地 embedding 模型设置。
     */
    private renderLocalEmbeddingSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(this.t("settings.localEmbeddingModel.name"))
            .setDesc(this.t("settings.localEmbeddingModel.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_EMBEDDING_MODEL)
                    .setValue(this.plugin.settings.embeddingModel)
                    .onChange(async (value: string) => {
                        this.plugin.settings.embeddingModel = value.trim() || DEFAULT_EMBEDDING_MODEL;
                        await this.plugin.saveSettings();
                        this.plugin.markVectorIndexDirty();
                    }),
            );
    }

    /**
     * 云端 embedding 模型设置。
     */
    private renderCloudEmbeddingSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(this.t("settings.cloudEmbeddingBaseUrl.name"))
            .setDesc(this.t("settings.cloudEmbeddingBaseUrl.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_CLOUD_EMBEDDING_BASE_URL)
                    .setValue(this.plugin.settings.cloudEmbeddingBaseUrl)
                    .onChange(async (value: string) => {
                        this.plugin.settings.cloudEmbeddingBaseUrl = value.trim() || DEFAULT_CLOUD_EMBEDDING_BASE_URL;
                        await this.plugin.saveSettings();
                        this.plugin.markVectorIndexDirty();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.cloudEmbeddingModel.name"))
            .setDesc(this.t("settings.cloudEmbeddingModel.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_CLOUD_EMBEDDING_MODEL)
                    .setValue(this.plugin.settings.cloudEmbeddingModel)
                    .onChange(async (value: string) => {
                        this.plugin.settings.cloudEmbeddingModel = value.trim() || DEFAULT_CLOUD_EMBEDDING_MODEL;
                        await this.plugin.saveSettings();
                        this.plugin.markVectorIndexDirty();
                    }),
            );
    }

    /**
     * 本地推理服务地址设置。
     */
    private renderLocalServiceAddressSetting(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(this.t("settings.localServiceBaseUrl.name"))
            .setDesc(this.t("settings.localServiceBaseUrl.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_OLLAMA_BASE_URL)
                    .setValue(this.plugin.settings.llmBaseUrl)
                    .onChange(async (value: string) => {
                        this.plugin.settings.llmBaseUrl = value.trim() || DEFAULT_OLLAMA_BASE_URL;
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.embeddingProvider === "ollama") {
                            this.plugin.markVectorIndexDirty();
                        }
                    }),
            );
    }

    /**
     * 云端 API key 设置。
     *
     * 使用 Obsidian SecretComponent，避免把密钥明文写入普通设置 JSON。
     */
    private renderCloudApiKeySetting(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(this.t("settings.cloudApiKey.name"))
            .setDesc(this.t("settings.cloudApiKey.desc"))
            .addComponent((el) =>
                new SecretComponent(this.app, el)
                    .setValue(this.plugin.settings.cloudApiKeySecretName)
                    .onChange(async (value: string) => {
                        this.plugin.settings.cloudApiKeySecretName = value;
                        await this.plugin.saveSettings();
                    }),
            );
    }

    /**
     * 独立 rerank 服务设置。
     */
    private renderRerankSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(this.t("settings.rerankBaseUrl.name"))
            .setDesc(this.t("settings.rerankBaseUrl.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(this.t("settings.rerankBaseUrl.placeholder"))
                    .setValue(this.plugin.settings.rerankBaseUrl)
                    .onChange(async (value: string) => {
                        this.plugin.settings.rerankBaseUrl = value.trim();
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(this.t("settings.rerankModel.name"))
            .setDesc(this.t("settings.rerankModel.desc"))
            .addText((text) =>
                text
                    .setPlaceholder(this.t("settings.rerankModel.placeholder"))
                    .setValue(this.plugin.settings.rerankModel)
                    .onChange(async (value: string) => {
                        this.plugin.settings.rerankModel = value.trim();
                        await this.plugin.saveSettings();
                    }),
            );
    }

    /**
     * 当前配置是否使用任意云端模型服务。
     */
    private usesCloudModel(): boolean {
        return this.plugin.settings.modelProvider === "openai-compatible"
            || this.plugin.settings.embeddingProvider === "openai-compatible";
    }

    /**
     * 当前配置是否使用任意本地模型服务。
     */
    private usesLocalModel(): boolean {
        return this.plugin.settings.modelProvider === "ollama"
            || this.plugin.settings.embeddingProvider === "ollama";
    }

    /**
     * 给检索模式下拉框统一添加选项。
     */
    private addRetrievalModeOptions(dropdown: DropdownComponent): void {
        dropdown.addOption("keyword", this.t("view.retrieval.keyword"));
        dropdown.addOption("vector", this.t("view.retrieval.vector"));
        dropdown.addOption("hybrid", this.t("view.retrieval.hybrid"));
    }

    /**
     * 解析正整数。
     */
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

    /**
     * 规范化用户输入的目录路径。
     */
    private normalizeFolderPath(folderPath: string): string {
        const trimmedFolderPath: string = folderPath.trim();
        if (trimmedFolderPath.length === 0) {
            return "";
        }
        return normalizePath(trimmedFolderPath).replace(/\/$/, "");
    }

}
