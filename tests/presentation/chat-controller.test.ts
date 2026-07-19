import { describe, expect, it, vi } from "vitest";
import { ChatController, type ChatControllerEvent } from "../../src/presentation/controllers/chat-controller";
import type { VaultCoachPluginApi } from "../../src/presentation/plugin-api";
import type { StreamHandlers } from "../../src/app/chat/chat-types";
import type { AssistantAnswer } from "../../src/domain/retrieval/retrieval-types";

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolvePromise: ((value: T) => void) | null = null;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });

    return {
        promise,
        resolve(value: T): void {
            resolvePromise?.(value);
        },
    };
}

describe("ChatController", () => {
    it("coordinates message persistence, streaming state, and final cleanup", async () => {
        const appendUserMessage = vi.fn(async () => undefined);
        const streamAssistantTurn = vi.fn(async (_text: string, handlers?: StreamHandlers): Promise<AssistantAnswer> => {
            handlers?.onToken?.("回答");
            return {
                text: "回答",
                sources: [],
                retrievalModeUsed: "keyword" as const,
                queryRewrite: { originalQuery: "问题", rewrittenQuery: "问题", useRewrite: false },
            };
        });
        const api = {
            appendUserMessage,
            streamAssistantTurn,
            getKnowledgeIndexBusyState: () => ({ busy: false, phase: null, startedAt: null }),
            getMessages: () => [],
        } as unknown as VaultCoachPluginApi;
        const controller = new ChatController(api);
        const events: ChatControllerEvent["type"][] = [];
        controller.subscribe((event) => {
            events.push(event.type);
        });

        await controller.send("问题");

        expect(appendUserMessage).toHaveBeenCalledWith("问题");
        expect(streamAssistantTurn).toHaveBeenCalledWith("问题", expect.anything());
        const streamHandlers: StreamHandlers | undefined = streamAssistantTurn.mock.calls[0]?.[1];
        expect(streamHandlers?.abortSignal).toBeInstanceOf(AbortSignal);
        expect(events).toContain("messages-changed");
        expect(events).toContain("streaming-started");
        expect(events).toContain("streaming-token");
        expect(events).toContain("streaming-completed");
        expect(events.at(0)).toBe("busy-changed");
        expect(events.at(-1)).toBe("busy-changed");
        expect(controller.getState()).toEqual({
            busy: false,
            composing: false,
            streamingText: "",
            streamingStartedAt: null,
            firstTokenDurationMs: null,
        });
    });

    it("aborts an active turn and releases its controller on dispose", async () => {
        const deferred = createDeferred<AssistantAnswer>();
        const streamAssistantTurn = vi.fn((_text: string, handlers?: StreamHandlers): Promise<AssistantAnswer> => {
            expect(handlers?.abortSignal).toBeDefined();
            return deferred.promise;
        });
        const api = {
            appendUserMessage: async () => undefined,
            streamAssistantTurn,
            getKnowledgeIndexBusyState: () => ({ busy: false, phase: null, startedAt: null }),
        } as unknown as VaultCoachPluginApi;
        const controller = new ChatController(api);
        const sending = controller.send("问题");

        await vi.waitFor(() => expect(streamAssistantTurn).toHaveBeenCalledOnce());
        controller.stop();
        controller.dispose();
        deferred.resolve({
            text: "回答",
            sources: [],
            retrievalModeUsed: "keyword",
            queryRewrite: { originalQuery: "问题", rewrittenQuery: "问题", useRewrite: false },
        });
        await sending;

        expect(controller.getState().busy).toBe(false);
    });
});
