import { describe, expect, it, vi } from "vitest";
import { ChatService } from "../../../src/app/chat/chat-service";
import type { ChatServiceDependencies } from "../../../src/app/chat/chat-service";
import type { VaultCoachSettings } from "../../../src/app/config/settings-types";

function createService(): { service: ChatService; persist: ReturnType<typeof vi.fn> } {
    const service = new ChatService(() => ({
        defaultRetrievalMode: "hybrid",
        maxConversationMessages: 3,
    } as VaultCoachSettings));
    const persist = vi.fn(async () => undefined);
    service.setDependencies({
        persist,
        getDefaultGreeting: () => "你好，欢迎使用 VaultCoach。",
    } as unknown as ChatServiceDependencies);
    return { service, persist };
}

describe("ChatService", () => {
    it("owns retrieval mode and returns copied messages", async () => {
        const { service, persist } = createService();

        service.setRuntimeRetrievalMode("keyword");
        await service.appendUserMessage("测试问题");
        const messages = service.getMessages();
        messages[0]!.text = "external mutation";

        expect(service.getRuntimeRetrievalMode()).toBe("keyword");
        expect(service.getMessages()[0]?.text).toBe("测试问题");
        expect(persist).toHaveBeenCalledOnce();
    });

    it("preserves the greeting while trimming to the configured message limit", () => {
        const { service } = createService();

        service.resetConversation();
        service.hydrate([
            ...service.getMessages(),
            { role: "user", text: "一", createdAt: 1 },
            { role: "assistant", text: "二", createdAt: 2 },
            { role: "user", text: "三", createdAt: 3 },
        ]);

        expect(service.getMessages().map((message) => message.text)).toEqual([
            "你好，欢迎使用 VaultCoach。",
            "二",
            "三",
        ]);
    });
});
