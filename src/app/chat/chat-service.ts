import { normalizeObsidianMarkdown } from "../../markdown-normalizer";
import { AdvancedRagEngine } from "../../rag-engine";
import type { AnswerSource, AssistantAnswer, RetrievalMode } from "../../domain/retrieval/retrieval-types";
import type { LongTermMemoryService } from "../../memory/memory-service";
import type { ChatMessage, StreamHandlers } from "./chat-types";
import type { VaultCoachSettings } from "../config/settings-types";

export interface ChatServiceDependencies {
    ragEngine: AdvancedRagEngine;
    memoryService: LongTermMemoryService;
    ensureKnowledgeBaseReady(): Promise<void>;
    getKnowledgeScopeDescription(): string;
    persist(): Promise<void>;
    getDefaultGreeting(): string;
    onGenerationFinished(): void;
}

/** Owns in-memory chat state and the assistant-turn use case. */
export class ChatService {
    private readonly getSettings: () => VaultCoachSettings;
    private messages: ChatMessage[] = [];
    private runtimeRetrievalMode: RetrievalMode;
    private dependencies: ChatServiceDependencies | null = null;

    constructor(getSettings: () => VaultCoachSettings) {
        this.getSettings = getSettings;
        this.runtimeRetrievalMode = getSettings().defaultRetrievalMode;
    }

    setDependencies(dependencies: ChatServiceDependencies): void {
        this.dependencies = dependencies;
    }

    getRuntimeRetrievalMode(): RetrievalMode {
        return this.runtimeRetrievalMode;
    }

    setRuntimeRetrievalMode(mode: RetrievalMode): void {
        this.runtimeRetrievalMode = mode;
    }

    getMessages(): ChatMessage[] {
        return this.messages.map((message: ChatMessage) => ({ ...message }));
    }

    getMessagesForMemory(): ChatMessage[] {
        return this.messages;
    }

    hydrate(messages: readonly ChatMessage[]): void {
        this.messages = messages.map((message: ChatMessage) => ({ ...message }));
        this.trimMessages();
    }

    async appendUserMessage(text: string): Promise<void> {
        this.messages.push({ role: "user", text, createdAt: Date.now() });
        this.trimMessages();
        await this.requireDependencies().persist();
    }

    addAssistantMessage(text: string, sources: AnswerSource[], generationDurationMs?: number): void {
        this.messages.push({
            role: "assistant",
            text: normalizeObsidianMarkdown(text),
            createdAt: Date.now(),
            generationDurationMs,
            sources,
        });
        this.trimMessages();
    }

    resetConversation(): void {
        this.messages = [{
            role: "assistant",
            text: this.requireDependencies().getDefaultGreeting(),
            createdAt: Date.now(),
        }];
        void this.requireDependencies().persist();
    }

    async streamAssistantTurn(userText: string, handlers?: StreamHandlers): Promise<AssistantAnswer> {
        const dependencies = this.requireDependencies();
        const generationStartedAt: number = Date.now();
        let firstChunkDurationMs: number | null = null;
        const effectiveHandlers: StreamHandlers = {
            ...handlers,
            onToken: (token: string) => {
                if (firstChunkDurationMs === null && token.length > 0) {
                    firstChunkDurationMs = Math.max(0, Date.now() - generationStartedAt);
                }
                handlers?.onToken?.(token);
            },
        };

        await dependencies.ensureKnowledgeBaseReady();
        const memoryContext: string = dependencies.memoryService.buildContext(userText);
        try {
            const answer: AssistantAnswer = await dependencies.ragEngine.streamAnswerQuestion(
                userText,
                this.messages,
                dependencies.getKnowledgeScopeDescription(),
                memoryContext,
                effectiveHandlers,
            );
            const generationDurationMs: number = firstChunkDurationMs ?? Math.max(0, Date.now() - generationStartedAt);
            const answerWithDuration: AssistantAnswer = { ...answer, generationDurationMs };
            this.addAssistantMessage(answerWithDuration.text, answerWithDuration.sources, generationDurationMs);
            if (!effectiveHandlers.abortSignal?.aborted) {
                await dependencies.memoryService.updateFromAssistantTurn(userText, answerWithDuration.text);
            }
            await dependencies.persist();
            return answerWithDuration;
        } finally {
            dependencies.onGenerationFinished();
        }
    }

    private requireDependencies(): ChatServiceDependencies {
        if (!this.dependencies) {
            throw new Error("ChatService must be initialized before use.");
        }

        return this.dependencies;
    }

    private trimMessages(): void {
        const maxMessages: number = Math.max(1, this.getSettings().maxConversationMessages);
        if (this.messages.length <= maxMessages) {
            return;
        }

        const greeting: ChatMessage | undefined = this.messages.find((message: ChatMessage) => message.role === "assistant");
        const tail: ChatMessage[] = this.messages.slice(-maxMessages);
        this.messages = greeting && !tail.includes(greeting)
            ? [greeting, ...tail.slice(1)]
            : tail;
    }
}
