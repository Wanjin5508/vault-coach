import { Notice, Plugin, WorkspaceLeaf, TAbstractFile } from 'obsidian';
import { VIEW_TYPE_VAULT_COACH } from './constants';
import { DEFAULT_SETTINGS, VaultCoachSettingTab } from "./settings";
import type { ChatMessage, VaultCoachSettings } from "./types";
import { VaultCoachView } from "./view";


/**
 *  VaultCoach 插件主类， 
 * 所有插件都会从这个类开始
 */
export default class VaultCoach extends Plugin {
	// 插件设置
	settings: VaultCoachSettings = DEFAULT_SETTINGS;

	/**
	 * 当前运行时的对话消息列表
	 * ! 注意: 这里先只保存在内存中，重启 Obsidian 后会重置
	 * TODO 后续可以把它保存在 data.json 中
	 */
	private messages: ChatMessage[] = [];

	// 插件加载时调用
	async onload(): Promise<void> {
		// 1. 先加载设置
		await this.loadSettings();

		// 2. 初始化会话
		this.resetConversation();

		// 3. 注册自定义视图
		this.registerView(
			VIEW_TYPE_VAULT_COACH,
			(leaf: WorkspaceLeaf) => new VaultCoachView(leaf, this)
		);

		// 4. 注册命令：打开右侧边栏中的 VaultCoach
		this.addCommand({
			// id: "open-vault-coach-view",
			id: "open-view",
			name: "Open the sidebar view on the right side",
			callback: async () => {
				await this.activateView();
			},
		});

		// 5。 注册命令，重置对话
		this.addCommand({
			// id: "reset-vault-coach-conversation",
			id: "reset-onversation",
			name: "Reset plugin 对话",
			callback: () => {
				this.resetConversation();
				this.refreshAllViews();
				new Notice("Reset successful.");
			},
		});

		// 6. 左侧 Ribbon 图标，点击可以快速打开右侧边栏视图
		this.addRibbonIcon("message-square", "Open vault coach", () => {
			void this.activateView();
		});

		// 7. 注册设置页
		this.addSettingTab(new VaultCoachSettingTab(this.app, this));

		// 8. 如果设置为启动时自动打开，则在布局准备完成后打开右侧视图
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.openInRightSidebarOnStartup) {
				void this.activateView();
			}
		});

	}

	// 插件卸载时调用
	onunload(): void {
		// 移除所有同类型的视图
		// this.app.workspace.detachLeavesOfType(VIEW_TYPE_VAULT_COACH);
	}

	// 加载设置
	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<VaultCoachSettings>
		);
	}

	// 保存设置
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// * 打开右侧边栏中的 VaultCoach 视图，这是实现“显示在右侧边栏同时在右上标签区域可切换的关键方法“
	async activateView(): Promise<void> {
		const { workspace } = this.app;

		// 先检查当前是否已经打开了这个视图
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH)[0] ?? null;

		// 如果没有，就在右侧边栏新建一个
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);

			if (!leaf) {
				new Notice("Cannot create a new view");
				return;
			}

			await leaf.setViewState({
				type: VIEW_TYPE_VAULT_COACH,
				active: true,
			});
		}

		// 让这个叶子节点显示出来
		void workspace.revealLeaf(leaf);
	}

	// 获取当前全部消息，提供给视图层使用
	getMessages(): ChatMessage[] {
		return this.messages;
	}

	// 添加用户消息
	addUserMessage(text: string): void {
		this.messages.push({
			role: "user",
			text, 
			createdAt: Date.now(),
		})
	};

	// 添加助手消息
	addAssistantMessage(text: string): void {
		this.messages.push({
			role: "assistant",
			text, 
			createdAt: Date.now(),
		});
	}

	// 重置当前会话，清空旧的消息，并重新放入一条默认欢迎语
	resetConversation(): void {
		this.messages = [
			{
				role: "assistant",
				text: this.settings.defaultGreeting || `你好，我是 ${this.settings.assistantName}。`,
				createdAt: Date.now(),
			},
		];
	}

	// 刷新所有已经打开的 VaultCoach 视图。比如修改设置、清空对话后都可以调用它
	refreshAllViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH);

		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof VaultCoachView) {
				view.refresh();
			}
		}
	}

	/**  当前版本只是一个 demo，后续需要在这里接入
	 * - 本地 LLM
	 * - Ollama
	 * - RAG 检索
	 * - 当前笔记上下文
	 * -记忆
	 * 其他模态，例如图像识别、pdf 读取。。。
	 */
	async generateDemoReply(userText: string): Promise<string> {
		// 模拟一点异步延迟，从而加深 async / await的理解
		await new Promise((resolve) => window.setTimeout(resolve, 300))
		console.warn("这里是异步延迟的模拟")

		return [`我是 ${this.settings.assistantName}。`,
			"",
			`你刚刚输入的是：${userText}`,
			"",
			"当前这版代码先完成了以下功能：",
			"1. 在 Obsidian 右侧边栏显示对话界面",
			"2. 支持输入消息和显示回复",
			"3. 支持设置页与启动自动打开",
			"",
			"下一步你可以把这里替换成真正的本地 LLM / RAG 调用逻辑。",
		].join("\n");

	}


}



