// 默认设置值以及设置页的 UI以及持久化入口

import {App, PluginSettingTab, Setting} from "obsidian";
import {
	DEFAULT_CHUNK_OVERLAP,
	DEFAULT_CHUNK_SIZE,
	DEFAULT_SOURCE_LIMIT,
	DEFAULT_KEYWORD_TOP_K
} from "./constants"
import type VaultCoach from "./main"; // 默认导出，不使用花括号
import type { VaultCoachSettings, KnowledgeBaseStats, KnowledgeScopeMode } from "./types";

/**
 * 插件默认设置
 * 当用户第一次安装插件、还没有保存过配置时，就会使用这些默认值。
 */
export const DEFAULT_SETTINGS: VaultCoachSettings = {
	assistantName: "VaultCoach",
	defaultGreeting: "你好，我是 VaultCoach。当前阶段已经支持扫描 Markdown 知识库、按标题切块、关键词检索，以及回答后的来源折叠展示。",
	openInRightSidebarOnStartup: true,
	knowledgeScopeMode: "wholeVault",
	knowledgeFolder: "",
	chunkSize: DEFAULT_CHUNK_SIZE,
	chunkOverlap: DEFAULT_CHUNK_OVERLAP,
	keywordSearchTopK: DEFAULT_KEYWORD_TOP_K,
	answerSourceLimit: DEFAULT_SOURCE_LIMIT,
	collapseSourcesByDefault: true,
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


		// ---------------
		// A 基础显示 i 设置
		// ---------------
		// 设置 1. 助手名称
		new Setting(containerEl)
				.setName("助手名称")
				.setDesc("请输入助手名称")
				.addText(text => 
					text
					.setPlaceholder("请输入助手名称")
					.setValue(this.plugin.settings.assistantName)
					.onChange(async (value) => {
						this.plugin.settings.assistantName = value.trim() || "VaultCoach";
						await this.plugin.saveSettings();

						// 刷新已经打开的视图，让 UI 立即更新
						this.plugin.refreshAllViews();
					})
				);

		// 设置 2：默认欢迎语
		new Setting(containerEl)
			.setName("默认欢迎语")
			.setDesc("当你重复会话时，助手显示的第一条信息。")
			.addTextArea((text) => 
			text
				.setPlaceholder("请输入默认欢迎语")
				.setValue(this.plugin.settings.defaultGreeting)
				.onChange(async (value) => { 
					this.plugin.settings.defaultGreeting = value.trim() || "你好，我是 VaultCoach，你可以向我提问任何问题。";
					await this.plugin.saveSettings();
				}) 
			);

		// 设置 3：启动时自动打开右侧边栏
		new Setting(containerEl)
		.setName("Open vaultcoach automatically on startup")
		.setDesc("Automatically open vaultcoach when Obsidian starts up.")
		.addToggle((toggle) => 
			toggle
			.setValue(this.plugin.settings.openInRightSidebarOnStartup)
			.onChange(async (value) => {
				this.plugin.settings.openInRightSidebarOnStartup = value;
				await this.plugin.saveSettings();
			})
		);

		// 设置 4：重置会话按钮
		new Setting(containerEl)
			.setName("重置当前会话")
			.setDesc("点击此按钮，将清空当前会话，并重新开始新的对话。")
			.addButton((button) => 
				button
					.setButtonText("Reset")
					.setCta()
					.onClick(async () => {
						this.plugin.resetConversation();
						this.plugin.refreshAllViews();
					})
				);

		// ---------------
		// B 知识库范围设置
		// ---------------
		new Setting(containerEl)
				.setHeading()
				.setName("Knowledgebase scope settings")
				.setDesc("控制索引扫描的 Markdown 文件范围。")

		new Setting(containerEl)
				.setName("Scan scope")
				.setDesc("Use 'wholevault' to scan the whole vault, or 'specificfolder' for a specific one.")
				.addDropdown((dropdown) => 
					dropdown
						.addOption("wholdVault", "整个仓库")
						.addOption("specificFolder", "指定目录")
						.setValue(this.plugin.settings.knowledgeScopeMode)
						.onChange(async (value: string) => {
							this.plugin.settings.knowledgeScopeMode = value as KnowledgeScopeMode;
							await this.plugin.saveSettings();
							this.plugin.markKnowledgeBaseDirty();
							this.display()
						}),
				)

		new Setting(containerEl)
			.setName("Scan directory")
			.setDesc("当扫描范围为“指定目录”时生效。") // ? 箭头函数什么时候用花括号什么时候省略？？？
			.addText((text) => 
				text
					.setPlaceholder("请输入 vault 内部目录路径")
					.setValue(this.plugin.settings.knowledgeFolder)
					.setDisabled(this.plugin.settings.knowledgeScopeMode != "specificFolder")
					.onChange(async (value: string) => {
						this.plugin.settings.knowledgeFolder = value.trim();
						await this.plugin.saveSettings();
						this.plugin.markKnowledgeBaseDirty();
					}),
			);

		// ---------------
		// C chunking 与检索设置
		// ---------------
		new Setting(containerEl)
			.setHeading()
			.setName("索引与检索参数")
			// .setDesc("")

		new Setting(containerEl)
			.setName("Chunk size")
			// .setDesc("")
			.addText((text) => 
				text
					.setPlaceholder(String(DEFAULT_CHUNK_SIZE))
					.setValue(String(this.plugin.settings.chunkSize))
					.onChange(async (value: string) => {
						const parsedValue: number = Number.parseInt(value, 10);
						this.plugin.settings.chunkSize = Number.isFinite(parsedValue) && parsedValue > 100
							? parsedValue
							: DEFAULT_CHUNK_SIZE;
						await this.plugin.saveSettings();
						this.plugin.markKnowledgeBaseDirty();
					}),
				);
				
				
		new Setting(containerEl)
				.setName("Chunk overlap")
				.setDesc("Overlap")
				.addText((text) => 
					text
						.setPlaceholder(String(DEFAULT_CHUNK_OVERLAP))
						.setValue(String(this.plugin.settings.chunkOverlap))
						.onChange(async (value: string) => {
							const parsedValue: number = Number.parseInt(value, 10)
							this.plugin.settings.chunkOverlap = Number.isFinite(parsedValue) && parsedValue >= 0
								? parsedValue
								: DEFAULT_CHUNK_OVERLAP;
							await this.plugin.saveSettings();
							this.plugin.markKnowledgeBaseDirty();
						}),
				);

		new Setting(containerEl)
				.setName("关键词召回数量")
				.setDesc("每次关键词检索最多返回多少个候选片段。")
				.addText((text) => 
					text
						.setPlaceholder(String(DEFAULT_KEYWORD_TOP_K))
						.setValue(String(this.plugin.settings.keywordSearchTopK))
						.onChange(async (value: string) => {
							const parsedValue: number = Number.parseInt(value, 10);
							this.plugin.settings.keywordSearchTopK = Number.isFinite(parsedValue) && parsedValue > 0
								? parsedValue
								: DEFAULT_KEYWORD_TOP_K;
							await this.plugin.saveSettings();
						}),
				);

		new Setting(containerEl)
            .setName("来源展示条数")
            .setDesc("每次回复下方最多显示多少条来源链接。")
            .addText((text) =>
                text
                    .setPlaceholder(String(DEFAULT_SOURCE_LIMIT))
                    .setValue(String(this.plugin.settings.answerSourceLimit))
                    .onChange(async (value: string) => {
                        const parsedValue: number = Number.parseInt(value, 10);
                        this.plugin.settings.answerSourceLimit = Number.isFinite(parsedValue) && parsedValue > 0
                            ? parsedValue
                            : DEFAULT_SOURCE_LIMIT;
                        await this.plugin.saveSettings();
                    }),
            );

		new Setting(containerEl)
            .setName("来源默认折叠")
            .setDesc("开启后，每条回答下方的来源区域默认折叠。")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.collapseSourcesByDefault)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.collapseSourcesByDefault = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshAllViews();
                    }),
            );

		// ---------------------------
        // 4. 手动操作区
        // ---------------------------
		new Setting(containerEl)
			.setHeading()
			.setName("手动操作")
			.setDesc("用于调试和理解当前阶段的行为。")

		new Setting(containerEl)
			.setName("重建知识库索引")
			.setDesc("当你修改了知识库目录、Markdown 文件内容，或怀疑索引未更新时，可以手动重建。")
			.addButton((button) => 
				button
					.setButtonText("重建索引")
					.setCta()
					.onClick( async () => {
						await this.plugin.rebuildKnowledgeBase(true);
					}),
		);

		new Setting(containerEl)
			.setName("重置当前会话")
			.setDesc("点击此按钮，将清空当前会话，并重新开始新的对话.")
			.addButton((button) => 
				button
					.setButtonText("Reset")
					.onClick(() => {
						this.plugin.resetConversation();
						this.plugin.refreshAllViews();
					}),
			);


	}
}



