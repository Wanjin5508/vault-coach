// 最关键的文件，用于将插件做成右侧的边栏视图

import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer } from "obsidian";
import type VaultCoach  from "./main";
import type { ChatMessage, AnswerSource, KnowledgeBaseStats, RetrievalMode, VectorIndexStats } from "./types";
import { VIEW_NAME_VAULT_COACH, VIEW_TYPE_VAULT_COACH } from "./constants";

/**
 * VaultCoachView 是一个自定义 ItemView。它不会像 Modal 那样弹窗，而是被放进 Obsidian 右侧边栏中。
 *
 * 第二阶段的界面重点：
 * - 支持切换 keyword / vector / hybrid
 * - 展示文本索引与向量索引状态
 * - assistant 回答按 Markdown 渲染
 * - 继续支持来源折叠与点击跳转
 */
export class VaultCoachView extends ItemView {
    plugin: VaultCoach;

    // 消息列表容器， 后面渲染消息时会往这个元素里塞内容
    private messageListEl!: HTMLDivElement;

    // 输入框元素
    private inputEl!: HTMLTextAreaElement;

    // 发送按钮元素，单独保存出来，便于在异步请求期间禁用按钮
    private sendButtonEl!: HTMLButtonElement;

    // 检索模式选择元素
    private retrievalModeSelectEl!: HTMLSelectElement;

    // 当前是否正等待插件完成检索回复
    private isBusy = false;

    constructor(leaf: WorkspaceLeaf, plugin: VaultCoach) {
        super(leaf);
        this.plugin = plugin;
    }

    // 返回当前视图的唯一类型 ID，Obsidian 通过它识别这是哪个视图
    getViewType(): string {
        return VIEW_TYPE_VAULT_COACH;
    }

    // 返回显示给用户看的标题，通常显示在标签页标题、悬浮窗标题和视图标题
    getDisplayText(): string {
        return VIEW_NAME_VAULT_COACH;
    }

    // 返回视图图标名称，图标会显示在右侧上方标签区域
    // TODO 后续可以改成其他图标名称
    getIcon(): string {
        return "message-square";
    }

    // 当视图被打开时调用
    async onOpen(): Promise<void> {
        this.render();
    }

    // 当视图被关闭时调用
    async onClose(): Promise<void> {
        this.containerEl.empty();
    }

    // 对外暴露的刷新方法，当 settings 变化、会话重置后，可以重新渲染界面
    public refresh(): void {
        this.render();
    }

    // render 方法，负责完整渲染界面
    // 当前写法是初学者友好的，逻辑清晰，好调试
    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        // 给根节点添加 class，方便 css 做样式
        contentEl.addClass('vault-coach-view');

        // 最外层根容器
        const rootEl: HTMLDivElement = contentEl.createDiv({ cls: "vault-coach-root"});
        this.renderHeader(rootEl);
        this.renderMessageArea(rootEl);
        this.renderInputArea(rootEl);
    }

    /**
     * 渲染头部区域：
     * - 助手名称
     * - 当前索引范围
     * - 当前索引状态
     * - 重建索引 / 重置会话按钮
     */
    private renderHeader(rootEl: HTMLDivElement): void {
        const headerEl: HTMLDivElement = rootEl.createDiv({ cls: "vault-coach-header"});
        headerEl.createEl("h3", { text: this.plugin.settings.assistantName});
        headerEl.createEl("p", {
            text: "Query rewrite + 向量检索 + 混合召回 + rerank + Markdown 回答渲染。"
        });

        const textStats: KnowledgeBaseStats = this.plugin.getKnowledgeBaseStats();
        const vectorStats: VectorIndexStats = this.plugin.getVectorIndexStats();
        const infoListEl: HTMLDivElement = headerEl.createDiv({cls: "vault-coach-header-info"});

        infoListEl.createEl("div", {
            text: `Knowledge base scope: ${this.plugin.getKnowledgeScopeDescription()}`
        });

        const textIndexStatusText: string = this.plugin.isKnowledgeBaseDirty()
            ? "待重建"
            : (textStats.lastIndexedAt ? "已就绪" : "尚未建立");

        infoListEl.createEl("div", {
            text: `文本索引：${textIndexStatusText}`,
        });

        const vectorIndexStatusText: string = vectorStats.ready
            ? `已就绪（${vectorStats.vectorCount} 条）`
            : "未建立 / 已回退";

        infoListEl.createEl("div", {
            text: `向量索引：${vectorIndexStatusText}`,
        });

        infoListEl.createEl("div", {
            text: `文件数：${textStats.fileCount}, 片段数：${textStats.chunkCount}`,
        });

        // infoListEl.createEl("div", {
        //     text: `检索方式：关键词检索（第一阶段）`,
        // });

        const toolbarEl: HTMLDivElement = headerEl.createDiv({ cls: "vault-coach-toolbar" });

        const retrievalGroupEl: HTMLDivElement = toolbarEl.createDiv({ cls: "vault-coach-retrieval-group"});
        retrievalGroupEl.createSpan({text: "检索模式： "});
        this.retrievalModeSelectEl = retrievalGroupEl.createEl("select");
        this.addRetrievalOption("keyword", "关键词检索");
        this.addRetrievalOption("vector", "向量检索");
        this.addRetrievalOption("hybrid", "混合检索");
        this.retrievalModeSelectEl.value = this.plugin.getRuntimeRetrievalMode();
        this.retrievalModeSelectEl.addEventListener("change", () => {
            const value: string = this.retrievalModeSelectEl.value;
            if (value === "keyword" || value === "vector" || value === "hybrid" ) {
                this.plugin.setRuntimeRetrievalMode(value);
            }
        });

        const rebuildButtonEl: HTMLButtonElement = toolbarEl.createEl("button", {
            text: "重建索引",
        });
        rebuildButtonEl.addEventListener("click", () => {
            void this.handleRebuildIndex();
        });

        const resetButtonEl: HTMLButtonElement = toolbarEl.createEl("button", {
            text: "重置会话",
        });
        resetButtonEl.addEventListener("click", () => {
            this.plugin.resetConversation();
            this.renderMessages();
            this.focusInput();
        });
    }

    private addRetrievalOption(value: RetrievalMode, label: string): void {
        const optionEl: HTMLOptionElement = this.retrievalModeSelectEl.createEl("option");
        optionEl.value = value;
        optionEl.text = label;
    }

    /**
     * 渲染消息区域
     */
    private renderMessageArea(rootEl: HTMLDivElement): void {
        this.messageListEl = rootEl.createDiv({cls: "vault-coach-message-list"});
        this.renderMessages();
    }

    /**
     * 渲染输入区域
     * 
     */
    private renderInputArea(rootEl: HTMLDivElement): void {
        const inputAreaEl: HTMLDivElement = rootEl.createDiv({ cls: "vault-coach-input-area"});
        this.inputEl = inputAreaEl.createEl("textarea", {
            cls: "vault-coach-input",
            attr: {
                placeholder: "请输入你的问题，按 Enter 发送, Shift + Enter 换行",
                rows: "4",
            },
        });

        const buttonRowEl: HTMLDivElement = inputAreaEl.createDiv({ cls: "vault-coach-button-row"});

        this.sendButtonEl = buttonRowEl.createEl("button", {
            text: "Send",
            cls: "mod-cta",
        });

        const clearButtonEl: HTMLButtonElement = buttonRowEl.createEl("button", {
            text: "Clear",
        });

        this.sendButtonEl.addEventListener("click", () => {
            void this.handleSend();
        });

        clearButtonEl.addEventListener("click", () => {
            this.inputEl.value = "";
            this.focusInput();
        });

        this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void this.handleSend();
            }
        });
    }

    /**
     * 重新渲染消息列表。
     *
     * * 这里改成 async 的原因是：
     * * - MarkdownRenderer.renderMarkdown() 是异步的；
     *   - 这样可以在渲染结束后再统一滚动到底部。
     */
    private async renderMessages(): Promise<void> {
        this.messageListEl.empty();

        const messages: ChatMessage[] = this.plugin.getMessages();

        // 如果没消息，则显示空状态提示
        if (messages.length === 0) {
            const emptyStateEl: HTMLDivElement = this.messageListEl.createDiv({
                cls: "vault-coach-empty-state",
            });
            emptyStateEl.setText("No messages yet");
            return;
        }

        // 逐条渲染消息
        for (const message of messages) {
            await this.createMessageBubble(message);
        }

        // 滚动到最底部，方便看到最新消息
        this.messageListEl.scrollTop = this.messageListEl.scrollHeight; 
        //* Height 是整个滚动容器的总高度， Top 是滚动条顶部距离容器顶部的距离

    }

    /**
     * 创建单条消息气泡。
     *
     * 第二阶段的关键改动：
     * - 不再使用 setText 直接显示 assistant 内容；
     * - 统一交给 MarkdownRenderer 渲染。
     */
    private async createMessageBubble(message: ChatMessage): Promise<void> {
        const wrapperEl: HTMLDivElement = this.messageListEl.createDiv({
            cls: `vault-coach-message-wrapper ${message.role}`,
        });

        // 消息头部：显示角色和时间
        const metaEl: HTMLDivElement = wrapperEl.createDiv({
            cls: "vault-coach-message-meta",
        });
        metaEl.setText(
            `${message.role === "user" ? "you" : this.plugin.settings.assistantName}` +
            ` · ${this.formatTime(message.createdAt)}`
        );

        // 消息气泡
        const bubbleEl: HTMLDivElement = wrapperEl.createDiv({
            cls: `vault-coach-message-bubble ${message.role}`,
        });

        // 追加 Obsidian 常用的 markdown 渲染类名
        // 这样列表、标题、代码块等元素会更接近原生预览样式
        bubbleEl.addClass("markdown-rendered");

        // setText 不会保留换行显示，因此这里通过 whiteSpace = pre-wrap 让多行文本能够正确展示。
        // bubbleEl.style.whiteSpace = "pre-wrap";
        // bubbleEl.setText(message.text);
        const sourcePath: string = this.app.workspace.getActiveFile()?.path ?? "";
        await MarkdownRenderer.render(this.app, message.text, bubbleEl, sourcePath, this)

        // 如果是助手消息，并且携带来源，则在下方渲染折叠来源区域
        if (message.role == "assistant" && message.sources && message.sources.length > 0) {
            this.renderSources(wrapperEl, message.sources);
        }


    }

    /**
     * 渲染回答下方的“来源折叠区”。
     *
     * 这里故意没有使用 block id 或段落定位，
     * 而是仅仅使用“文件路径 + heading”的形式，符合当前阶段的要求。
     */
    private renderSources(wrapperEl: HTMLDivElement, sources: AnswerSource[]): void {
        const detailsEl: HTMLDetailsElement = wrapperEl.createEl("details", {
            cls: "vault-coach-source-details",
        });

        if (!this.plugin.settings.collapseSourcesByDefault) {
            detailsEl.open = true;
        }

        detailsEl.createEl("summary", {
            text: `Sources: ${sources.length}`,
        });

        for (const source of sources){
            const itemEl: HTMLDivElement = detailsEl.createDiv({ cls: "vault-coach-source-item"});
            const linkButtonEl: HTMLButtonElement = itemEl.createEl("button", {
                cls: "vault-coach-source-link",
                text: source.displayLink,
            });

            linkButtonEl.addEventListener("click", () => {
                void this.plugin.openSource(source);
            });

            itemEl.createDiv({
                cls: "vault-coach-source-excerpt",
                text: source.excerpt,
            });
        }
    }


    // 处理发送逻辑
    private async handleSend(): Promise<void> {
        const userText: string = this.inputEl.value.trim();

        // 用户什么都没输入，就不发送
        if (!userText || this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.sendButtonEl.disabled = true;
        this.inputEl.disabled = true;
        this.retrievalModeSelectEl.disabled = true;

        try {
            // 1. 将用户消息加入对话
            this.plugin.addUserMessage(userText);

            // 2.  清空输入框
            this.inputEl.value = "";

            // 3. 立刻刷新消息区域，让用户先看到自己的消息
            await this.renderMessages();

            // 4. 生成助手回复 
            // TODO 目前还只是展示逻辑，后续再接入本地 LLM
            const answer = await this.plugin.answerQuestion(userText);

            // 5. 把助手回复加入对话
            this.plugin.addAssistantMessage(answer.text, answer.sources);

            // 6. 再次刷新消息区域
            await this.renderMessages();

        } catch (error: unknown) {
            console.error("[VaultCoachView] 发送消息失败", error);
            new Notice("发送失败，请打开开发者控制台查看错误信息。")
        } finally {
            this.isBusy = false;
            this.sendButtonEl.disabled = false;
            this.inputEl.disabled = false;
            this.retrievalModeSelectEl.disabled = false;
            // 7. 把焦点重新放回输入框
            this.focusInput();
        }
    }

    /**
     * 手动重建索引
     */
    private async handleRebuildIndex(): Promise<void> {
        if (this.isBusy) {
            return;
        }

        this.isBusy = true;
        this.sendButtonEl?.setAttribute("disabled", "true");
        this.retrievalModeSelectEl?.setAttribute("disabled", "true");

        try {
            await this.plugin.rebuildKnowledgeBase(true);
        } finally {
            this.isBusy = false;
            this.sendButtonEl?.removeAttribute("disabled");
            this.retrievalModeSelectEl?.removeAttribute("disabled");
            this.focusInput();
        }
    }

    /**
     * 聚焦输入框
     *  */ 
    private focusInput(): void {
        this.inputEl.focus();
    }

    /**
     * 格式化时间
     * @param timestamp 
     * @returns 
     */
    private formatTime(timestamp: number): string {
        return new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

}



