import { isAbortError } from "../../utils/errors";
import type { ChatMessage } from "../../app/chat/chat-types";
import type { AnswerSource, AssistantAnswer, RetrievalMode } from "../../domain/retrieval/retrieval-types";
import type { VaultCoachSettings } from "../../app/config/settings-types";
import type { VaultCoachPluginApi } from "../plugin-api";

export interface ChatControllerState {
    busy: boolean;
    composing: boolean;
    streamingText: string;
    streamingStartedAt: number | null;
    firstTokenDurationMs: number | null;
}

export type ChatControllerEvent =
    | { type: "busy-changed"; busy: boolean }
    | { type: "messages-changed" }
    | { type: "streaming-started" }
    | { type: "streaming-token"; token: string }
    | { type: "streaming-timer-updated" }
    | { type: "streaming-completed"; answer: AssistantAnswer }
    | { type: "generation-stopped" }
    | { type: "send-failed"; error: unknown };

export type ChatControllerListener = (event: ChatControllerEvent) => void | Promise<void>;

export interface ClipboardPort {
    writeText(text: string): Promise<void>;
}

export type ChatTimerWindow = Pick<Window, "setInterval" | "clearInterval">;
export type ChatTimerWindowProvider = () => ChatTimerWindow;

/** Owns chat interaction state and exposes UI-neutral actions. */
export class ChatController {
    private readonly listeners: Set<ChatControllerListener> = new Set();
    private state: ChatControllerState = {
        busy: false,
        composing: false,
        streamingText: "",
        streamingStartedAt: null,
        firstTokenDurationMs: null,
    };
    private activeAbortController: AbortController | null = null;
    private streamingTimerId: number | null = null;
    private streamingTimerWindow: ChatTimerWindow | null = null;

    constructor(
        private readonly api: VaultCoachPluginApi,
        private readonly getTimerWindow: ChatTimerWindowProvider,
    ) {}

    getState(): Readonly<ChatControllerState> {
        return { ...this.state };
    }

    getMessages(): ChatMessage[] {
        return this.api.getMessages();
    }

    getSettings(): VaultCoachSettings {
        return this.api.settings;
    }

    isIndexBusy(): boolean {
        return this.api.getKnowledgeIndexBusyState().busy;
    }

    getActiveChatModelName(): string {
        return this.api.getActiveChatModelName();
    }

    getActiveEmbeddingModelName(): string {
        return this.api.getActiveEmbeddingModelName();
    }

    getRetrievalMode(): RetrievalMode {
        return this.api.getRuntimeRetrievalMode();
    }

    setRetrievalMode(mode: RetrievalMode): void {
        this.api.setRuntimeRetrievalMode(mode);
    }

    resetConversation(): void {
        this.api.resetConversation();
    }

    setComposing(composing: boolean): void {
        this.state = { ...this.state, composing };
    }

    shouldLetInputMethodHandleKey(event: KeyboardEvent): boolean {
        return this.state.composing || event.isComposing || this.getLegacyKeyCode(event) === 229;
    }

    async send(userText: string): Promise<void> {
        if (!userText || this.state.busy || this.api.getKnowledgeIndexBusyState().busy) {
            return;
        }

        this.activeAbortController = new AbortController();
        await this.setBusy(true);

        try {
            await this.api.appendUserMessage(userText);
            await this.emit({ type: "messages-changed" });

            this.startStreaming();
            await this.emit({ type: "streaming-started" });

            const answer: AssistantAnswer = await this.api.streamAssistantTurn(userText, {
                onToken: (token: string) => this.handleStreamingToken(token),
                abortSignal: this.activeAbortController.signal,
            });

            if (this.activeAbortController.signal.aborted) {
                await this.emit({ type: "generation-stopped" });
            }
            await this.emit({ type: "streaming-completed", answer });
        } catch (error: unknown) {
            if (isAbortError(error)) {
                await this.emit({ type: "generation-stopped" });
            } else {
                await this.emit({ type: "send-failed", error });
            }
        } finally {
            this.activeAbortController = null;
            this.clearStreamingState();
            await this.setBusy(false);
        }
    }

    stop(): void {
        if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
            return;
        }

        this.activeAbortController.abort();
    }

    async copyMessage(text: string, clipboard: ClipboardPort): Promise<void> {
        await clipboard.writeText(text);
    }

    openSource(source: AnswerSource): Promise<void> {
        return this.api.openSource(source);
    }

    subscribe(listener: ChatControllerListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    dispose(): void {
        this.activeAbortController?.abort();
        this.activeAbortController = null;
        this.clearStreamingState();
        this.state = { ...this.state, busy: false, composing: false };
        this.listeners.clear();
    }

    private handleStreamingToken(token: string): void {
        if (this.state.streamingText.length === 0 && token.length > 0) {
            this.freezeStreamingTimerAtFirstToken();
        }

        this.state = {
            ...this.state,
            streamingText: `${this.state.streamingText}${token}`,
        };
        void this.emit({ type: "streaming-token", token });
    }

    private startStreaming(): void {
        this.clearStreamingState();
        this.state = {
            ...this.state,
            streamingText: "",
            streamingStartedAt: Date.now(),
            firstTokenDurationMs: null,
        };
        this.emitStreamingTimerUpdate();
        this.streamingTimerWindow = this.getTimerWindow();
        this.streamingTimerId = this.streamingTimerWindow.setInterval(() => this.emitStreamingTimerUpdate(), 1000);
    }

    private freezeStreamingTimerAtFirstToken(): void {
        if (this.state.streamingStartedAt === null || this.state.firstTokenDurationMs !== null) {
            return;
        }

        this.state = {
            ...this.state,
            firstTokenDurationMs: Math.max(0, Date.now() - this.state.streamingStartedAt),
        };
        this.clearStreamingTimer();
        void this.emit({ type: "streaming-timer-updated" });
    }

    private emitStreamingTimerUpdate(): void {
        void this.emit({ type: "streaming-timer-updated" });
    }

    private clearStreamingState(): void {
        this.clearStreamingTimer();
        this.state = {
            ...this.state,
            streamingText: "",
            streamingStartedAt: null,
            firstTokenDurationMs: null,
        };
    }

    private clearStreamingTimer(): void {
        if (this.streamingTimerId === null) {
            return;
        }

        this.streamingTimerWindow?.clearInterval(this.streamingTimerId);
        this.streamingTimerId = null;
        this.streamingTimerWindow = null;
    }

    private async setBusy(busy: boolean): Promise<void> {
        this.state = { ...this.state, busy };
        await this.emit({ type: "busy-changed", busy });
    }

    private async emit(event: ChatControllerEvent): Promise<void> {
        for (const listener of this.listeners) {
            await listener(event);
        }
    }

    private getLegacyKeyCode(event: KeyboardEvent): number | null {
        const eventRecord: Record<string, unknown> = event as unknown as Record<string, unknown>;
        const keyCode: unknown = eventRecord["keyCode"];
        return typeof keyCode === "number" ? keyCode : null;
    }
}
