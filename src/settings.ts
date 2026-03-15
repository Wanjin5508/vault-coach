// 默认设置值以及设置页的 UI以及持久化入口

import {App, PluginSettingTab, Setting} from "obsidian";
import type VaultCoach from "./main"; // 默认导出，不使用花括号
import type { VaultCoachSettings } from "./types";

/**
 * 插件默认设置
 * 当用户第一次安装插件、还没有保存过配置时，就会使用这些默认值。
 */
export const DEFAULT_SETTINGS: VaultCoachSettings = {
	assistantName: "VaultCoach",
	defaultGreeting: "你好，我是 VaultCoach。当前版本已经支持在右侧边栏中显示对话界面。",
	openInRightSidebarOnStartup: true,
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
			.setName("Settings")

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

		
	}
}



