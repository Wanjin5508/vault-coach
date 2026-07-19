import { describe, expect, it, vi } from "vitest";
import { VaultCoachApplication, type VaultCoachApplicationDependencies } from "../../src/app/vault-coach-application";

describe("VaultCoachApplication", () => {
    it("publishes grouped chat use-case events without a presentation dependency", async () => {
        const appendUserMessage = vi.fn(async () => undefined);
        const application = new VaultCoachApplication({
            chatService: {
                getMessages: () => [],
                appendUserMessage,
                streamAssistantTurn: async () => ({ text: "回答", sources: [], retrievalModeUsed: "keyword", rewriteResult: { originalQuery: "", rewrittenQuery: "", useRewrite: false } }),
                resetConversation: () => undefined,
            },
        } as unknown as VaultCoachApplicationDependencies);
        const events: string[] = [];
        const unsubscribe = application.subscribe((event) => events.push(event.type));

        await application.chat.appendUserMessage("问题");
        application.chat.resetConversation();
        unsubscribe();

        expect(appendUserMessage).toHaveBeenCalledWith("问题");
        expect(events).toEqual(["conversation-changed", "conversation-changed"]);
        expect(application.progress.isAvailable()).toBe(false);
    });
});
