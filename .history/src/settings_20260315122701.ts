import {App, PluginSettingTab, Setting} from "obsidian";
import MyPlugin from "./main";

// 该文件负责设置类型和设置面板 UI 以及持久化入口

export interface CoachSettings {
	mySetting: string;
}

export const DEFAULT_SETTINGS: CoachSettings = {
	mySetting: 'default'
}

export class CoachSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Settings #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
