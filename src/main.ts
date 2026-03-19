import { Notice, Plugin, WorkspaceLeaf, TAbstractFile } from 'obsidian';
import { VIEW_TYPE_VAULT_COACH } from './constants';
import { VaultKnowledgeBase } from 'knowledge-base';
import { AdvancedRagEngine } from 'rag-engine';
import { DEFAULT_SETTINGS, VaultCoachSettingTab } from "./settings";
import type { 
    AnswerSource,
    AssistantAnswer,
    ChatMessage,
    KnowledgeBaseStats,
    RetrievalMode,
    VectorIndexStats,
    VaultCoachSettings,
} from "./types";
import { VaultCoachView } from "./view";


/**
 *  VaultCoach 插件主类， 
 * 所有插件都会从这个类开始
 * 
 *  * 职责拆分：
 * - main.ts：插件入口、全局状态、命令注册、视图注册、索引重建调度
 * - knowledge-base.ts：扫描、切块、关键词索引、向量索引容器
 * - rag-engine.ts：第二阶段的 Advanced RAG 流程
 * - view.ts：右侧边栏 UI
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

	/**
	 * 第一阶段建立的知识库基础设施。
	 * 非 LLM 阶段的知识库核心对象
	 * 该对象负责扫描用户指定的目录下的 md 文件，并进行切块、索引构建以及关键词检索
	 */
	private knowledgeBase!: VaultKnowledgeBase;

	/**
	 * 第二阶段新增的 Advanced RAG 引擎。
	 */
	private ragEngine: AdvancedRagEngine;

	/**
     * dirty 标记表示“当前索引可能已经过期，需要重建”。
     *
     * 典型触发场景：
     * - 用户修改了设置中的知识库目录
     * - vault 中有 Markdown 文件被创建/修改/删除/重命名
     */
	private knowledgeBaseDirty: boolean = true;

	/**
     * 当前运行时生效的检索模式。
     *
     * 为什么不直接只用 settings.defaultRetrievalMode：
     * - default 更像“初始值”；
     * - runtimeMode 则允许用户在当前会话里随时切换，而不一定要改设置页。
     */
	private runtimeRetrievalMode: RetrievalMode = DEFAULT_SETTINGS.defaultRetrievalMode;

	// 插件加载时调用
	async onload(): Promise<void> {
		// 1. 先加载设置
		await this.loadSettings();

		// 2. 初始化知识库对象
		this.runtimeRetrievalMode = this.settings.defaultRetrievalMode;
		this.knowledgeBase = new VaultKnowledgeBase(this.app, () => this.settings);
		this.ragEngine = new AdvancedRagEngine(
			this.knowledgeBase,
			() => this.settings,
			() => this.runtimeRetrievalMode,
		)

		// 3. 初始化会话
		this.resetConversation();

		// 4. 注册自定义视图
		this.registerView(
			VIEW_TYPE_VAULT_COACH,
			(leaf: WorkspaceLeaf) => new VaultCoachView(leaf, this)
		);

		// 5. 注册命令：打开右侧边栏中的 VaultCoach
		this.addCommand({
			// id: "open-vault-coach-view",
			id: "open-view",
			name: "Open the sidebar view on the right side",
			callback: async () => {
				await this.activateView();
			},
		});

		// 6。 注册命令，重置对话
		this.addCommand({
			// id: "reset-vault-coach-conversation",
			id: "reset-onversation",
			name: "Reset plugin conversation",
			callback: () => {
				this.resetConversation();
				this.refreshAllViews();
				new Notice("Reset successful.");
			},
		});

		// 7. 注册命令：手动重建知识库索引
		this.addCommand({
			id: "rebuild-knowledge-index",
			name: "Rebuild Markdown knowledge index.",
			callback: async () => {
				await this.rebuildKnowledgeBase(true);
			},
		});

		// 8. 左侧 Ribbon 图标，点击可以快速打开右侧边栏视图
		// TODO 考虑前端美化，使用更好看的图标，往上有资源
		this.addRibbonIcon("message-square", "Open vault coach", () => {
			void this.activateView();
		});

		// 9. 注册设置页
		this.addSettingTab(new VaultCoachSettingTab(this.app, this));

		// 10. 监听 vault 变化，让索引状态保持可解释
		this.registerVaultEvents();

		// 11. 启动时先建立一次索引
		await this.rebuildKnowledgeBase(false);

		// 12. 如果设置为启动时自动打开，则在布局准备完成后打开右侧视图
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

	/**
     * 当设置项影响到知识库范围或索引行为时，调用这个方法。
     *
     * 它不会立刻强制重建索引，而是先把索引标记为 dirty，
     * 然后由用户点击“重建索引”或在下一次提问时自动重建。
     */
	markKnowledgeBaseDirty(): void {
		this.knowledgeBaseDirty = true;
		this.refreshAllViews();
	}

	/**
     * 获取当前索引状态是否需要重建。
     */
	isKnowledgeBaseDirty(): boolean {
		return this.knowledgeBaseDirty;
	}

	// 保存设置
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
     * 获取知识库统计信息，供 view 层展示。
     */
	getKnowledgeBaseStats(): KnowledgeBaseStats {
		return this.knowledgeBase.getStats();
	}

	getVectorIndexStats(): VectorIndexStats {
        return this.ragEngine.getVectorIndexStats();
    }

	/**
     * 获取当前索引范围的人类可读描述。
     */
	getKnowledgeScopeDescription(): string {
		const stats: KnowledgeBaseStats = this.getKnowledgeBaseStats();
		return stats.scopeDescription;
	}

	getRuntimeRetrievalMode(): RetrievalMode {
        return this.runtimeRetrievalMode;
    }

    setRuntimeRetrievalMode(mode: RetrievalMode): void {
        this.runtimeRetrievalMode = mode;
        this.refreshAllViews();
    }

	/**
     * 手动触发一次知识库重建。
	 * 
	 *  * 第二阶段的重建现在包含两部分：
     * 1. 文本索引（扫描 / 切块 / 倒排索引）
     * 2. 向量索引（embedding）
     */
	async rebuildKnowledgeBase(showNotice: boolean): Promise<void> {
		try {
			const textStats: KnowledgeBaseStats = await this.knowledgeBase.rebuildIndex();
			let vectorStats: VectorIndexStats = this.ragEngine.getVectorIndexStats();
            let vectorBuildWarning = "";

			try {
                vectorStats = await this.ragEngine.rebuildVectorIndex();
            } catch (vectorError: unknown) {
                console.error("[VaultCoach] 向量索引建立失败，将回退到关键词检索。", vectorError);
                vectorBuildWarning = "向量索引建立失败，已自动回退到关键词检索。";
            }

			this.knowledgeBaseDirty = false;
			this.refreshAllViews();

			if (showNotice) {
				const vectorInfo: string = this.settings.enableVectorRetrieval
                    ? `，向量数 ${vectorStats.vectorCount}`
                    : "";
                const message: string = `索引完成：${textStats.fileCount} 个文件，${textStats.chunkCount} 个片段${vectorInfo}。`;

                new Notice(vectorBuildWarning.length > 0 ? `${message} ${vectorBuildWarning}` : message);
			}
		} catch (error: unknown) {
			console.error("[VaultCoach] 重建索引失败", error);
			if (showNotice) {
				new Notice("重建索引失败，请打开开发者控制台查看错误信息。");
			}
		}
	}

	/**
     * 如果索引尚未建立，或者已经被标记为 dirty，则先自动重建。
	 * ? 编程时如何确定一个方法/函数是否应该写成异步？
     */
	async ensureKnowledgeBaseReady(): Promise<void> {
		if (!this.knowledgeBase.isReady() || this.knowledgeBaseDirty) {
			await this.rebuildKnowledgeBase(false)
		}
	}

	/**
     * 打开右侧边栏中的 VaultCoach 视图。
     *
     * 这是实现“显示在右侧边栏，同时在右上标签区域可切换”的关键方法。
     */
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
		// void workspace.revealLeaf(leaf);
		await workspace.revealLeaf(leaf);
	}

	/**
     * 获取当前全部消息，提供给视图层使用。
     */
	getMessages(): ChatMessage[] {
		return this.messages;
	}

	/**
     * 添加用户消息。
     */
	addUserMessage(text: string): void {
		this.messages.push({
			role: "user",
			text, 
			createdAt: Date.now(),
		})
	};

	/**
     * 添加助手消息。
     */
	addAssistantMessage(text: string, sources: AnswerSource[]): void {
		this.messages.push({
			role: "assistant",
			text, 
			createdAt: Date.now(),
			sources,
		});
	}

	/**
     * 重置当前会话，清空旧消息，并重新放入一条默认欢迎语。
	 * 
	 * 第二阶段开始，默认欢迎语允许使用 Markdown，
     * 因此这里直接把 setting 中的字符串原样作为消息正文保存。
     */
	resetConversation(): void {
		this.messages = [
			{
				role: "assistant",
				text: this.settings.defaultGreeting || `# 你好\n\n我是 ${this.settings.assistantName}。`,
				createdAt: Date.now(),
			},
		];
	}

	/**
     * 刷新所有已经打开的 VaultCoach 视图。
     * 比如修改设置、清空对话、重建索引后都可以调用它。
     */
	refreshAllViews(): void {
		const leaves: WorkspaceLeaf[] = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH);

		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof VaultCoachView) {
				view.refresh();
			}
		}
	}

	/**
     * 第二阶段的回答逻辑。
     *
     * 处理流程：
     * 1. 确保索引可用
     * 2. query rewrite
     * 3. 根据当前 retrieval mode 做召回
     * 4. hybrid merge
     * 5. rerank
     * 6. 构造 prompt 与上下文
     * 7. 调用本地模型生成 Markdown 答案
     */
	async answerQuestion(userText: string): Promise<AssistantAnswer> {
		await this.ensureKnowledgeBaseReady();

		return this.ragEngine.answerQuestion(
			userText, 
			this.messages,
			this.getKnowledgeScopeDescription(),
		)
	}


	/**
     * 点击来源后的跳转逻辑。
     *
     * 当前阶段只要求精确到 heading 级别，因此这里直接使用：
     * - 文件路径
     * - 或 文件路径#Heading
     *
     * 然后交给 Obsidian 内部的 openLinkText 处理。
     */
	async openSource(source: AnswerSource): Promise<void> {
		const activeFilePath: string = this.app.workspace.getActiveFile()?.path ?? "";
		const linkTarget: string = source.heading
			? `${source.filePath}#${source.heading}`
			: source.filePath;
		
		await this.app.workspace.openLinkText(linkTarget, activeFilePath, false);
	}


	/**
     * 注册 vault 事件监听。
     *
     * 第一阶段不直接做自动增量更新，而是：
     * - 监听文件变化
     * - 把索引标记为 dirty
     * - 等用户下一次提问或手动点击“重建索引”时再重建
     */
	private registerVaultEvents(): void {
		
		const markDirtyIfMarkdown = (file: TAbstractFile): void => {
			if (this.isMarkdownPath(file.path)) {
				this.markKnowledgeBaseDirty();
			}
		};

		this.registerEvent(this.app.vault.on("create", (file: TAbstractFile) => {
			markDirtyIfMarkdown(file);
		}));

		this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {
			markDirtyIfMarkdown(file);
		}));

		this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
            markDirtyIfMarkdown(file);
        }));

        this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile) => {
            markDirtyIfMarkdown(file);
        }));
	}

	/**
     * 判断某个路径是否是 Markdown 文件。
     */
	private isMarkdownPath(path:string) {
		return path.toLowerCase().endsWith(".md");
	}
	


}



