import { Notice, Plugin, WorkspaceLeaf, TAbstractFile } from 'obsidian';
import { VIEW_TYPE_VAULT_COACH } from './constants';
import { VaultKnowledgeBase } from 'knowledge-base';
import { DEFAULT_SETTINGS, VaultCoachSettingTab } from "./settings";
import type { 
	AnswerSource,
	AssistantAnswer,
	ChatMessage, 
	IndexedChunk,
	KeywordSearchHit,
	KnowledgeBaseStats,
	VaultCoachSettings 
} from "./types";
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

	/**
	 * 非 LLM 阶段的知识库核心对象
	 * 该对象负责扫描用户指定的目录下的 md 文件，并进行切块、索引构建以及关键词检索
	 */
	private knowledgeBase!: VaultKnowledgeBase;

	/**
     * dirty 标记表示“当前索引可能已经过期，需要重建”。
     *
     * 典型触发场景：
     * - 用户修改了设置中的知识库目录
     * - vault 中有 Markdown 文件被创建/修改/删除/重命名
     */
	private knowledgeBaseDirty:boolean = true;

	// 插件加载时调用
	async onload(): Promise<void> {
		// 1. 先加载设置
		await this.loadSettings();

		// 2. 初始化知识库对象
		this.knowledgeBase = new VaultKnowledgeBase(this.app, () => this.settings);

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

	/**
     * 获取当前索引范围的人类可读描述。
     */
	getKnowledgeScopeDescription(): string {
		const stats: KnowledgeBaseStats = this.getKnowledgeBaseStats();
		return stats.scopeDescription;
	}

	/**
     * 手动触发一次知识库重建。
     */
	async rebuildKnowledgeBase(showNotice: boolean): Promise<void> {
		try {
			const stats: KnowledgeBaseStats = await this.knowledgeBase.rebuildIndex();
			this.knowledgeBaseDirty = false;
			this.refreshAllViews();

			if (showNotice) {
				new Notice(`索引完成：${stats.fileCount} 个文件，${stats.chunkCount} 个片段。`);
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
     */
	resetConversation(): void {
		this.messages = [
			{
				role: "assistant",
				text: this.settings.defaultGreeting || `你好，我是 ${this.settings.assistantName}。`,
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
     * 当前第一阶段的“回答逻辑”。
     *
     * 注意：这不是 LLM 生成，而是：
     * 1. 确保索引可用
     * 2. 执行关键词检索
     * 3. 把命中的相关片段组织成一个可读回复
     *
     * 这样做的意义是：先把 RAG 的“检索骨架”走通，
     * 等下一阶段接入本地 LLM 时，只需要替换这里的内部实现即可。
     */
	async answerQuestion(userText: string): Promise<AssistantAnswer> {
		await this.ensureKnowledgeBaseReady();

		const hits: KeywordSearchHit[] = this.knowledgeBase.search(
			userText,
			this.settings.keywordSearchTopK,
		);

		if (hits.length === 0) {
			return {
				text: [
                    `我在当前知识库范围（${this.getKnowledgeScopeDescription()}）内没有找到明显相关的 Markdown 片段。`,
                    "",
                    "你可以尝试以下办法：",
                    "1. 换一个更具体的关键词；",
                    "2. 检查设置中的知识库范围是否正确；",
                    "3. 点击“重建索引”后重新提问。",
                ].join("\n"),
                sources: [],
			};
		}

		const previewHits: KeywordSearchHit[] = hits.slice(0, 3);
		const answerLines: string[] = [
			`我在当前知识库范围（${this.getKnowledgeScopeDescription()}）内检索到了 ${hits.length} 个相关片段。`,
            "",
            "下面先给出基于关键词检索的整理结果：",
		];

		for (let index = 0; index < previewHits.length; index += 1) {
			// if (previewHits[index] === undefined) {
			// 	continue;
			// }

			const hit = previewHits[index];
			if (!hit) {
				continue;
			}

            // const hit: KeywordSearchHit = previewHits[index];
            const locationLabel: string = hit.chunk.primaryHeading
                ? `${hit.chunk.fileName} > ${hit.chunk.primaryHeading}`
                : hit.chunk.fileName;
            const excerpt: string = this.createExcerpt(hit.chunk.text, 140);
            const matchedTokens: string = hit.matchedTokens.slice(0, 8).join("、");

            answerLines.push(`${index + 1}. ${locationLabel}`);
            answerLines.push(`   ${excerpt}`);
            if (matchedTokens.length > 0) {
                answerLines.push(`   命中的关键词：${matchedTokens}`);
            }
            answerLines.push("");
        }

        answerLines.push("说明：当前阶段还没有接入 LLM，因此这里返回的是“检索到的相关片段整理结果”，而不是生成式总结。\n下一阶段你可以在此基础上接入问题改写、向量检索和重排序。 ");

        return {
            text: answerLines.join("\n"),
            sources: this.buildAnswerSources(hits),
        };
	}

	/**
     * 根据检索命中结果构建可展示的来源列表。
     *
     * 这里会做一个轻量去重：
     * - 如果多个 chunk 来自同一个文件的同一个 heading，则只展示一次来源
     */
	private buildAnswerSources(hits: KeywordSearchHit[]): AnswerSource[] {
		const uniqueSources: AnswerSource[] = []
		const seenKeys: Set<string> = new Set<string>();

		for (const hit of hits) {
			const source: AnswerSource = this.convertHitToSource(hit.chunk);
			const uniqueKey: string = `${source.filePath}::${source.heading ?? "__root__"}`;

			if (seenKeys.has(uniqueKey)) {
				continue;
			}

			uniqueSources.push(source);
			seenKeys.add(uniqueKey);

			if (uniqueSources.length >= this.settings.answerSourceLimit) {
				break;
			}
		}
		return uniqueSources;
	}

	/**
     * 将单个 chunk 转换为 AnswerSource。
     */
	private convertHitToSource(chunk: IndexedChunk): AnswerSource {
		const displayLink: string = chunk.primaryHeading
			? `[[${chunk.filePath}#${chunk.primaryHeading}]]`
			: `[[${chunk.filePath}]]`;

		return {
			filePath: chunk.filePath,
			heading: chunk.primaryHeading,
			displayLink,
			excerpt: this.createExcerpt(chunk.text, 180),

		};
	}

	/**
     * 生成简短摘录，用于消息正文与来源折叠区展示。
     */
	private createExcerpt(text: string, maxLength: number): string {
		const normalizedText: string = text.replace(/\s+/g, "").trim();
		if (normalizedText.length <= maxLength) {
			return normalizedText;
		}

		return `${normalizedText.slice(0, maxLength)}...`;
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



