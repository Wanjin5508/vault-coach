import { MarkdownRenderer, Notice, setIcon, type App, type Component } from "obsidian";
import { normalizeObsidianMarkdown } from "../../markdown-normalizer";
import { createShortErrorMessage, formatGenerationDuration, formatTime } from "../../ui/view-formatters";
import { translate, type TranslationKey } from "../../i18n";
import { renderThinkingIndicator } from "../components/loading-state";
import { renderSourceList } from "../components/source-list";
import {
    ChatController,
    type ChatControllerEvent,
    type ClipboardPort,
} from "../controllers/chat-controller";
import type { AnswerSource, AssistantAnswer } from "../../domain/retrieval/retrieval-types";
import type { ChatMessage } from "../../app/chat/chat-types";

/** Renders the Chat UI and converts DOM events into ChatController actions. */
export class ChatView {
    private messageListEl: HTMLDivElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendButtonEl: HTMLButtonElement | null = null;
    private stopButtonEl: HTMLButtonElement | null = null;
    private clearButtonEl: HTMLButtonElement | null = null;
    private streamingWrapperEl: HTMLDivElement | null = null;
    private streamingBubbleEl: HTMLDivElement | null = null;
    private streamingContentEl: HTMLDivElement | null = null;
    private streamingDurationEl: HTMLSpanElement | null = null;
    private active = false;
    private readonly unsubscribe: () => void;

    constructor(
        private readonly app: App,
        private readonly component: Component,
        private readonly controller: ChatController,
    ) {
        this.unsubscribe = controller.subscribe((event) => this.handleControllerEvent(event));
    }

    render(rootEl: HTMLDivElement): void {
        this.detach();
        this.active = true;
        this.renderMessageArea(rootEl);
        this.renderInputArea(rootEl);
    }

    detach(): void {
        this.active = false;
        this.clearStreamingBubble();
        this.messageListEl = null;
        this.inputEl = null;
        this.sendButtonEl = null;
        this.stopButtonEl = null;
        this.clearButtonEl = null;
    }

    dispose(): void {
        this.detach();
        this.unsubscribe();
    }

    focusInput(): void {
        this.inputEl?.focus();
    }

    hasInputText(): boolean {
        return this.inputEl?.isConnected === true && this.inputEl.value.length > 0;
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    private renderMessageArea(rootEl: HTMLDivElement): void {
        this.messageListEl = rootEl.createDiv({ cls: "vault-coach-message-list" });
        void this.renderMessages();
    }

    private renderInputArea(rootEl: HTMLDivElement): void {
        const inputAreaEl: HTMLDivElement = rootEl.createDiv({ cls: "vault-coach-input-area" });
        this.inputEl = inputAreaEl.createEl("textarea", {
            cls: "vault-coach-input",
            attr: {
                placeholder: this.t("view.inputPlaceholder"),
                rows: "4",
            },
        });

        const buttonRowEl: HTMLDivElement = inputAreaEl.createDiv({ cls: "vault-coach-button-row" });
        this.sendButtonEl = buttonRowEl.createEl("button", {
            text: this.t("view.send"),
            cls: "mod-cta",
        });
        this.clearButtonEl = buttonRowEl.createEl("button", {
            text: this.t("view.clear"),
        });
        this.stopButtonEl = buttonRowEl.createEl("button", {
            text: this.t("view.stopGenerating"),
            cls: "vault-coach-stop-button",
        });

        this.renderModelStatus(buttonRowEl);
        this.updateInteractiveControls();

        this.sendButtonEl.addEventListener("click", () => {
            this.sendCurrentInput();
        });
        this.clearButtonEl.addEventListener("click", () => {
            if (this.inputEl) {
                this.inputEl.value = "";
            }
            this.focusInput();
        });
        this.stopButtonEl.addEventListener("click", () => {
            this.stopButtonEl?.setAttribute("disabled", "true");
            this.controller.stop();
        });
        this.inputEl.addEventListener("compositionstart", () => this.controller.setComposing(true));
        this.inputEl.addEventListener("compositionend", () => this.controller.setComposing(false));
        this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
            if (this.controller.shouldLetInputMethodHandleKey(event)) {
                return;
            }

            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.sendCurrentInput();
            }
        });
    }

    private renderModelStatus(buttonRowEl: HTMLDivElement): void {
        const modelStatusEl: HTMLDivElement = buttonRowEl.createDiv({ cls: "vault-coach-model-status" });
        const chatModelName = this.controller.getActiveChatModelName() || this.t("view.modelUnset");
        const embeddingModelName = this.controller.getActiveEmbeddingModelName() || this.t("view.modelUnset");

        modelStatusEl.createSpan({
            cls: "vault-coach-model-status-item",
            text: this.t("view.modelStatus.chat", { model: chatModelName }),
        });
        modelStatusEl.createSpan({
            cls: "vault-coach-model-status-item",
            text: this.t("view.modelStatus.embedding", { model: embeddingModelName }),
        });
    }

    private sendCurrentInput(): void {
        const userText = this.inputEl?.value.trim() ?? "";
        if (!userText) {
            return;
        }

        if (this.inputEl) {
            this.inputEl.value = "";
        }
        void this.controller.send(userText);
    }

    private updateInteractiveControls(): void {
        const state = this.controller.getState();
        const disabled = state.busy || this.controller.isIndexBusy();
        if (this.inputEl) {
            this.inputEl.disabled = disabled;
        }
        if (this.sendButtonEl) {
            this.sendButtonEl.disabled = disabled;
        }
        if (this.clearButtonEl) {
            this.clearButtonEl.disabled = state.busy;
        }
        if (this.stopButtonEl) {
            this.stopButtonEl.disabled = !state.busy;
        }
    }

    private async handleControllerEvent(event: ChatControllerEvent): Promise<void> {
        if (!this.active) {
            return;
        }

        switch (event.type) {
            case "busy-changed":
                this.updateInteractiveControls();
                if (!event.busy) {
                    this.focusInput();
                }
                return;
            case "messages-changed":
                await this.renderMessages();
                return;
            case "streaming-started":
                this.beginStreamingBubble();
                return;
            case "streaming-token":
                this.appendStreamingToken();
                return;
            case "streaming-timer-updated":
                this.updateStreamingDuration();
                return;
            case "streaming-completed":
                await this.finalizeStreamingBubble(event.answer);
                return;
            case "generation-stopped":
                this.clearStreamingBubble();
                new Notice(this.t("view.generationStopped"));
                return;
            case "send-failed":
                this.clearStreamingBubble();
                console.error("[VaultCoachChatView] 发送消息失败", event.error);
                new Notice(this.t("view.sendFailed", { message: createShortErrorMessage(event.error) }));
                return;
        }
    }

    private async renderMessages(): Promise<void> {
        const messageListEl = this.messageListEl;
        if (!messageListEl) {
            return;
        }

        messageListEl.empty();
        this.resetStreamingElements();
        const messages = this.controller.getMessages();

        if (messages.length === 0) {
            messageListEl.createDiv({
                cls: "vault-coach-empty-state",
                text: this.t("view.noMessages"),
            });
            return;
        }

        for (const message of messages) {
            await this.createMessageBubble(messageListEl, message);
        }

        if (messageListEl !== this.messageListEl) {
            return;
        }

        if (this.controller.getState().streamingStartedAt !== null) {
            this.beginStreamingBubble();
        }
        this.scrollMessagesToBottom();
    }

    private async createMessageBubble(messageListEl: HTMLDivElement, message: ChatMessage): Promise<void> {
        const wrapperEl: HTMLDivElement = messageListEl.createDiv({
            cls: `vault-coach-message-wrapper ${message.role}`,
        });
        const bubbleEl: HTMLDivElement = wrapperEl.createDiv({
            cls: `vault-coach-message-bubble ${message.role}`,
        });
        const contentEl: HTMLDivElement = bubbleEl.createDiv({
            cls: "vault-coach-message-content markdown-rendered",
        });
        await MarkdownRenderer.render(
            this.app,
            normalizeObsidianMarkdown(message.text),
            contentEl,
            this.getActiveSourcePath(),
            this.component,
        );

        this.createMessageFooter(bubbleEl, message.role, message.createdAt, () => message.text, message.generationDurationMs);
        if (message.role === "assistant" && message.sources && message.sources.length > 0) {
            await this.renderSources(wrapperEl, message.sources);
        }
    }

    private createMessageFooter(
        bubbleEl: HTMLDivElement,
        role: ChatMessage["role"],
        createdAt: number,
        getText: () => string,
        generationDurationMs?: number,
    ): HTMLDivElement {
        const metaEl: HTMLDivElement = bubbleEl.createDiv({ cls: "vault-coach-message-meta" });
        metaEl.createSpan({
            cls: "vault-coach-message-meta-label",
            text: `${role === "user" ? this.t("view.you") : this.controller.getSettings().assistantName} · ${formatTime(createdAt)}`,
        });
        if (role === "assistant" && generationDurationMs !== undefined) {
            metaEl.createSpan({
                cls: "vault-coach-message-duration",
                text: formatGenerationDuration(generationDurationMs, (key, replacements) => this.t(key, replacements)),
            });
        }
        this.createMessageCopyButton(metaEl, getText);
        return metaEl;
    }

    private createMessageCopyButton(metaEl: HTMLDivElement, getText: () => string): void {
        const copyButtonEl: HTMLButtonElement = metaEl.createEl("button", {
            cls: "vault-coach-message-copy-button",
            attr: {
                "aria-label": this.t("view.copyMessage"),
                title: this.t("view.copyMessage"),
                type: "button",
            },
        });
        setIcon(copyButtonEl, "copy");
        copyButtonEl.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            void this.copyMessage(getText(), copyButtonEl);
        });
    }

    private async copyMessage(text: string, copyButtonEl: HTMLButtonElement): Promise<void> {
        try {
            await this.controller.copyMessage(text, this.getClipboardPort(copyButtonEl));
            new Notice(this.t("view.copyMessageSuccess"));
            setIcon(copyButtonEl, "check");
            window.setTimeout(() => {
                if (copyButtonEl.isConnected) {
                    setIcon(copyButtonEl, "copy");
                }
            }, 1200);
        } catch (error: unknown) {
            console.error("[VaultCoachChatView] 复制消息失败", error);
            new Notice(this.t("view.copyMessageFailed", { message: createShortErrorMessage(error) }));
        }
    }

    private getClipboardPort(element: HTMLElement): ClipboardPort {
        return {
            writeText: async (text: string) => {
                const clipboard = element.ownerDocument.defaultView?.navigator.clipboard;
                if (!clipboard?.writeText) {
                    throw new Error("Clipboard API is unavailable in the current environment.");
                }
                await clipboard.writeText(text);
            },
        };
    }

    private async renderSources(wrapperEl: HTMLDivElement, sources: AnswerSource[]): Promise<void> {
        await renderSourceList({
            app: this.app,
            component: this.component,
            containerEl: wrapperEl,
            sources,
            collapseByDefault: this.controller.getSettings().collapseSourcesByDefault,
            sourcePath: this.getActiveSourcePath(),
            t: (key, replacements) => this.t(key, replacements),
            openSource: (source) => this.controller.openSource(source),
        });
    }

    private beginStreamingBubble(): void {
        const messageListEl = this.messageListEl;
        const state = this.controller.getState();
        if (!messageListEl || state.streamingStartedAt === null || this.streamingBubbleEl) {
            return;
        }

        const wrapperEl: HTMLDivElement = messageListEl.createDiv({
            cls: "vault-coach-message-wrapper assistant",
        });
        const bubbleEl: HTMLDivElement = wrapperEl.createDiv({
            cls: "vault-coach-message-bubble assistant vault-coach-streaming-bubble",
        });
        const contentEl: HTMLDivElement = bubbleEl.createDiv({
            cls: "vault-coach-message-content vault-coach-streaming-content",
        });
        renderThinkingIndicator(contentEl, (key, replacements) => this.t(key, replacements));
        const footerEl = this.createMessageFooter(
            bubbleEl,
            "assistant",
            state.streamingStartedAt,
            () => this.controller.getState().streamingText,
            0,
        );

        this.streamingWrapperEl = wrapperEl;
        this.streamingBubbleEl = bubbleEl;
        this.streamingContentEl = contentEl;
        this.streamingDurationEl = footerEl.querySelector<HTMLSpanElement>(".vault-coach-message-duration");
        if (state.streamingText.length > 0) {
            this.appendStreamingToken();
        } else {
            this.updateStreamingDuration();
        }
        this.scrollMessagesToBottom();
    }

    private appendStreamingToken(): void {
        if (!this.streamingBubbleEl || !this.streamingContentEl) {
            this.beginStreamingBubble();
        }

        const state = this.controller.getState();
        if (state.streamingText.length > 0) {
            this.streamingContentEl?.removeClass("vault-coach-thinking-bubble");
            this.streamingContentEl?.empty();
        }
        this.streamingContentEl?.setText(state.streamingText);
        this.updateStreamingDuration();
        this.scrollMessagesToBottom();
    }

    private updateStreamingDuration(): void {
        const state = this.controller.getState();
        if (!this.streamingDurationEl || state.streamingStartedAt === null) {
            return;
        }

        const duration = state.firstTokenDurationMs ?? Math.max(0, Date.now() - state.streamingStartedAt);
        this.streamingDurationEl.setText(formatGenerationDuration(duration, (key, replacements) => this.t(key, replacements)));
    }

    private async finalizeStreamingBubble(answer: AssistantAnswer): Promise<void> {
        const wrapperEl = this.streamingWrapperEl;
        const bubbleEl = this.streamingBubbleEl;
        if (!wrapperEl || !bubbleEl) {
            await this.renderMessages();
            return;
        }

        const state = this.controller.getState();
        const fallbackDuration = state.streamingStartedAt === null
            ? undefined
            : Math.max(0, Date.now() - state.streamingStartedAt);
        const generationDurationMs = state.firstTokenDurationMs ?? answer.generationDurationMs ?? fallbackDuration;

        bubbleEl.removeClass("vault-coach-streaming-bubble");
        bubbleEl.removeClass("vault-coach-thinking-bubble");
        bubbleEl.empty();
        const contentEl: HTMLDivElement = bubbleEl.createDiv({
            cls: "vault-coach-message-content markdown-rendered",
        });
        await MarkdownRenderer.render(
            this.app,
            normalizeObsidianMarkdown(answer.text),
            contentEl,
            this.getActiveSourcePath(),
            this.component,
        );
        this.createMessageFooter(bubbleEl, "assistant", Date.now(), () => answer.text, generationDurationMs);
        if (answer.sources.length > 0) {
            await this.renderSources(wrapperEl, answer.sources);
        }
        this.resetStreamingElements();
        this.scrollMessagesToBottom();
    }

    private clearStreamingBubble(): void {
        this.streamingWrapperEl?.remove();
        this.resetStreamingElements();
    }

    private resetStreamingElements(): void {
        this.streamingWrapperEl = null;
        this.streamingBubbleEl = null;
        this.streamingContentEl = null;
        this.streamingDurationEl = null;
    }

    private getActiveSourcePath(): string {
        return this.app.workspace.getActiveFile()?.path ?? "";
    }

    private scrollMessagesToBottom(): void {
        if (this.messageListEl) {
            this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
        }
    }
}
