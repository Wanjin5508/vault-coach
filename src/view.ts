// 最关键的文件，用于将插件做成右侧的边栏视图

import { ItemView, WorkspaceLeaf } from "obsidian";
import type VaultCoach  from "./main";
import type { ChatMessage } from "./types";
import { VIEW_NAME_VAULT_COACH, VIEW_TYPE_VAULT_COACH } from "./constants";

// VaultCoachView
// 这是一个自定义视图 ItemView
// 它不会像 Modal 那样弹窗，而是被放进 Obsidian 右侧边栏中。
export class VaultCoachView extends ItemView {
    plugin: VaultCoach;

    // 消息列表容器， 后面渲染消息时会往这个元素里塞内容
    private messageListEl!: HTMLDivElement;

    // 输入框元素
    private inputEl!: HTMLTextAreaElement;

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
        const root = contentEl.createDiv({ cls: "vault-coach-root"});

        // ---------------------------
		// 1. 头部区域
		// ---------------------------
        const headerEl = root.createDiv({ cls: "vault-coach-header"});
        // headerEl.createEl("h3", {text: this.plugin.settings?.assistantName ?? "VaultCoach"});
        const assistantName: string = this.plugin.settings.assistantName;
        headerEl.createEl("h3", { text: assistantName });

        headerEl.createEl("p", {
            text: "这是一个位于 Obsidian 右侧边栏的对话界面。",
        });


        // ---------------------------
		// 2. 消息列表区域
		// ---------------------------
        this.messageListEl = root.createDiv({ cls: "vault-coach-message-list"});
        this.renderMessages();


        // ---------------------------
		// 3. 输入区域
		// ---------------------------
        const inputAreaEl = root.createDiv({ cls: "vault-coach-input-area"});
        this.inputEl = inputAreaEl.createEl("textarea", {
            cls: "vault-coach-input",
            attr: {
                placeholder: "请输入你的问题，按 Enter 发送，Shift + Enter 换行"  ,
                rows: "4",
            },
        });

        const buttonRowEl = inputAreaEl.createDiv({ cls: "vault-coach-button-row"});
        
        // 发送按钮
        const sendButtonEl = buttonRowEl.createEl("button", {
            text: "发送",
            cls: "mod-cta",
        });

        const clearButtonEl = buttonRowEl.createEl("button", {
            text: "Clear",

        });

        // 点击发送按钮
        sendButtonEl.addEventListener("click", () => {
            void this.handleSend();
        });

        // 点击清空按钮
        clearButtonEl.addEventListener("click", () => {
            this.plugin.resetConversation();
            this.renderMessages();
            this.focusInput();
        });

        // 在输入框中按回车
        this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void this.handleSend();
            }
        });
    }

    // 渲染消息列表
    private renderMessages(): void {
        this.messageListEl.empty();

        const messages = this.plugin.getMessages();

        // 如果没消息，则显示空状态提示
        if (messages.length === 0) {
            const emptyStateEl = this.messageListEl.createDiv({
                cls: "vault-coach-empty-state",
            });
            emptyStateEl.setText("No messages yet");
            return;
        }

        // 逐条渲染消息
        for (const message of messages) {
            this.createMessageBubble(message);
        }

        // 滚动到最底部，方便看到最新消息
        this.messageListEl.scrollTop = this.messageListEl.scrollHeight; //? 为什么这么实现

    }

    // 创建单条消息气泡
    private createMessageBubble(message: ChatMessage): void {
        const wrapperEl = this.messageListEl.createDiv({
            cls: `vault-coach-message-wrapper ${message.role}`,

        });

        // 消息头部：显示角色和时间
        const metaEl = wrapperEl.createDiv({
            cls: "vault-coach-message-meta",
        });
        metaEl.setText(
            `${message.role === "user" ? "you" : this.plugin.settings.assistantName}` +
            ` · ${this.formatTime(message.createdAt)}`
        );

        // 消息气泡
        const bubbleEl = wrapperEl.createDiv({
            cls: `vault-coach-message-bubble ${message.role}`,
        });

        // 初代版本这里使用唇纹本显示
        // TODO 后续迭代需要支持 Markdown 格式
        bubbleEl.setText(message.text);

    }

    // 处理发送逻辑
    private async handleSend(): Promise<void> {
        const userText = this.inputEl.value.trim();

        // 用户什么都没输入，就不发送
        if (!userText) {
            return;
        }

        // 1. 将用户消息加入对话
        this.plugin.addUserMessage(userText);

        // 2.  清空输入框
        this.inputEl.value = "";

        // 3. 立刻刷新消息区域，让用户先看到自己的消息
        this.renderMessages();

        // 4. 生成助手回复 
        // TODO 目前还只是展示逻辑，后续再接入本地 LLM
        const assistantReply = await this.plugin.generateDemoReply(userText);

        // 5. 把助手回复加入对话
        this.plugin.addAssistantMessage(assistantReply);

        // 6. 再次刷新消息区域
        this.renderMessages();


        // 7. 把脚垫重新放回输入框
        this.focusInput();




    }

    // 聚焦输入框
    private focusInput(): void {
        this.inputEl.focus();
    }

    // 格式化时间
    private formatTime(timestamp: number): string {
        return new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

}



