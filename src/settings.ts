// 默认设置值以及设置页的 UI以及持久化入口

import {App, DropdownComponent, PluginSettingTab, Setting, normalizePath} from "obsidian";
import {
	DEFAULT_CHAT_MODEL,
    DEFAULT_CHUNK_OVERLAP,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CONTEXT_TOP_K,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_GENERATION_TEMPERATURE,
    DEFAULT_HYBRID_TOP_K,
    DEFAULT_KEYWORD_TOP_K,
    DEFAULT_OLLAMA_BASE_URL,
    DEFAULT_RERANK_TOP_K,
    DEFAULT_SOURCE_LIMIT,
    DEFAULT_VECTOR_TOP_K,
} from "./constants"
import type VaultCoach from "./main"; // 默认导出，不使用花括号
import type { VaultCoachSettings } from "./types";

/**
 * 插件默认设置
 * 当用户第一次安装插件、还没有保存过配置时，就会使用这些默认值。
 */
export const DEFAULT_SETTINGS: VaultCoachSettings = {
	assistantName: "VaultCoach",
    defaultGreeting: [
        "# 你好，我是 VaultCoach",
        "",
        "当前版本已经支持：",
        "- Markdown 知识库扫描与标题切块；",
        "- 关键词检索；",
        "- Query rewrite；",
        "- Embedding / 向量检索；",
        "- Hybrid merge；",
        "- Rerank；",
        "- Markdown 格式回答渲染。",
    ].join("\n"),
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
    llmBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    chatModel: DEFAULT_CHAT_MODEL,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    rerankBaseUrl: "",
    rerankModel: "",
};

// 插件的设置页类
// 设置 -> 社区插件 -> VaultCoach
export class VaultCoachSettingTab extends PluginSettingTab {
	plugin: VaultCoach;

	constructor(app: App, plugin: VaultCoach){
		super(app, plugin);
		this.plugin = plugin;
	}

	// display 用于渲染设置页界面，每次打开设置页的时候，Obsidian 都会调用这个方法
	display(): void { 
		const {containerEl} = this;
		containerEl.empty();

		// 设置页标题
		// containerEl.createEl("h2", {text: "VaultCoach 设置"});
		new Setting(containerEl)
			.setHeading()
			.setName("Vault coach settings")

		this.renderGeneralSection(containerEl);
        this.renderKnowledgeSection(containerEl);
        this.renderAdvancedRagSection(containerEl);
        this.renderLocalModelSection(containerEl);
	}

	/**
     * 基础显示与行为设置。
     */
	private renderGeneralSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName("基础")
            .setDesc("控制右侧边栏的基础显示与启动行为。 ");

        new Setting(containerEl)
            .setName("助手名称")
            .setDesc("显示在右侧边栏头部和助手消息中的名称。")
            .addText((text) =>
                text
                    .setPlaceholder("请输入助手名称")
                    .setValue(this.plugin.settings.assistantName)
                    .onChange(async (value: string) => {
                        this.plugin.settings.assistantName = value.trim() || "VaultCoach";
                        await this.plugin.saveSettings();
                        this.plugin.refreshAllViews();
                    }),
            );

        new Setting(containerEl)
            .setName("默认欢迎语")
            .setDesc("重置会话时显示的第一条助手消息。支持 Markdown。")
            .addTextArea((text) =>
                text
                    .setPlaceholder("请输入默认欢迎语")
                    .setValue(this.plugin.settings.defaultGreeting)
                    .onChange(async (value: string) => {
                        this.plugin.settings.defaultGreeting = value.trim() || DEFAULT_SETTINGS.defaultGreeting;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("启动时自动打开右侧边栏")
            // .setDesc("开启后，obsidian 布局准备完成时会自动打开 vaultcoach。")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.openInRightSidebarOnStartup)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.openInRightSidebarOnStartup = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("默认检索模式")
            .setDesc("右侧边栏打开时默认使用的召回通道。")
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
            .setName("来源默认折叠")
            .setDesc("开启后，回答下方的来源区域默认折叠显示。")
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
            .setName("知识库")
            .setDesc("控制 Markdown 文件的扫描范围与 chunk 策略。修改后建议重建索引。 ");

        new Setting(containerEl)
            .setName("扫描范围")
            // .setDesc("wholeVault 表示索引整个 vault；specificFolder 表示只索引某个指定目录。")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("wholeVault", "整个 vault")
                    .addOption("specificFolder", "指定目录")
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
            .setName("指定目录")
            .setDesc("仅在扫描范围为特定目录时生效。")
            .addText((text) =>
                text
                    .setPlaceholder("请输入目录路径")
                    .setValue(this.plugin.settings.knowledgeFolder)
                    .onChange(async (value: string) => {
                        this.plugin.settings.knowledgeFolder = this.normalizeFolderPath(value);
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName("Chunk 大小")
            .setDesc("每个片段允许的最大字符数。数值越大，上下文更完整，但 embedding 与生成开销也会更大。")
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
            .setName("Chunk 重叠")
            .setDesc("相邻 chunk 之间保留的字符数，用来减少切块边界损失。")
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
    }

    /**
     * 高级 RAG 检索参数。
     */
    private renderAdvancedRagSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName("Advanced rag")
            .setDesc("控制 query rewrite、向量检索、hybrid merge 与 rerank 的行为。 ");

        new Setting(containerEl)
            .setName("启用 query rewrite")
            .setDesc("开启后，插件会先把用户问题改写为更适合检索的查询。")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableQueryRewrite)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableQueryRewrite = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("启用向量检索")
            .setDesc("开启后，重建索引时会为 chunk 生成 embedding，并支持 vector / hybrid 模式。")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableVectorRetrieval)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableVectorRetrieval = value;
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName("启用 rerank")
            .setDesc("开启后，召回候选会进入重排阶段；如果未配置独立 rerank 服务，将自动回退到本地启发式重排。")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableRerank)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableRerank = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("关键词 top k")
            .setDesc("关键词召回保留的候选数量。")
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
            .setName("向量 top k")
            .setDesc("向量召回保留的候选数量。")
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
            .setName("Hybrid 候选上限")
            .setDesc("关键词 + 向量融合之后保留的候选数量上限。")
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
            .setName("Rerank top k")
            .setDesc("进入 rerank 阶段的候选数量上限。")
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
            .setName("上下文 chunks 数")
            .setDesc("最终真正注入到 prompt 中的 chunk 数量。不是越大越好，过多反而会稀释重点。")
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
            .setName("来源数量上限")
            .setDesc("每条回答下方最多展示多少条来源。")
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
            .setName("生成温度")
            .setDesc("控制回答的发散程度。rag 场景通常建议保持较低值。")
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
     * 本地模型服务连接参数。
     */
    private renderLocalModelSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setHeading()
            .setName("本地模型")
            .setDesc("默认按本地 ollama 风格接口工作。修改地址或模型后，建议重新提问；修改 embedding 模型后建议重建索引。 ");

        new Setting(containerEl)
            .setName("本地推理服务地址")
            .setDesc("例如：http://127.0.0.1:11434")
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_OLLAMA_BASE_URL)
                    .setValue(this.plugin.settings.llmBaseUrl)
                    .onChange(async (value: string) => {
                        this.plugin.settings.llmBaseUrl = value.trim() || DEFAULT_OLLAMA_BASE_URL;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("聊天模型")
            .setDesc("用于 query rewrite 与最终回答生成。")
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_CHAT_MODEL)
                    .setValue(this.plugin.settings.chatModel)
                    .onChange(async (value: string) => {
                        this.plugin.settings.chatModel = value.trim() || DEFAULT_CHAT_MODEL;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Embedding 模型")
            .setDesc("用于向量检索。修改后建议重建索引。")
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_EMBEDDING_MODEL)
                    .setValue(this.plugin.settings.embeddingModel)
                    .onChange(async (value: string) => {
                        this.plugin.settings.embeddingModel = value.trim() || DEFAULT_EMBEDDING_MODEL;
                        await this.plugin.saveSettings();
                        this.plugin.markKnowledgeBaseDirty();
                    }),
            );

        new Setting(containerEl)
            .setName("独立 rerank 服务地址")
            .setDesc("可选，例如：http://127.0.0.1:11435。留空时自动回退到本地启发式 rerank。")
            .addText((text) =>
                text
                    .setPlaceholder("留空表示不使用独立 rerank 服务")
                    .setValue(this.plugin.settings.rerankBaseUrl)
                    .onChange(async (value: string) => {
                        this.plugin.settings.rerankBaseUrl = value.trim();
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Rerank 模型")
            .setDesc("只有在配置了独立 rerank 服务地址后才会使用。")
            .addText((text) =>
                text
                    .setPlaceholder("例如：bge-reranker-v2-m3")
                    .setValue(this.plugin.settings.rerankModel)
                    .onChange(async (value: string) => {
                        this.plugin.settings.rerankModel = value.trim();
                        await this.plugin.saveSettings();
                    }),
            );
    }

    /**
     * 给检索模式下拉框统一添加选项。
     */
    private addRetrievalModeOptions(dropdown: DropdownComponent): void {
        dropdown.addOption("keyword", "关键词检索");
        dropdown.addOption("vector", "向量检索");
        dropdown.addOption("hybrid", "混合检索");
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

