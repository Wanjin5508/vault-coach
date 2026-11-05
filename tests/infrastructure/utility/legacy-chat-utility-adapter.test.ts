import { describe, expect, it, vi } from "vitest";
import type { ChatProvider } from "../../../src/domain/model/chat-provider";
import { LegacyChatUtilityAdapter } from "../../../src/infrastructure/utility/legacy-chat-utility-adapter";

describe("LegacyChatUtilityAdapter", () => {
    it("preserves the query rewrite request and result contract", async () => {
        const rewriteQuery = vi.fn(async (originalQuery: string) => ({
            originalQuery,
            rewrittenQuery: "rewritten",
            useRewrite: true,
        }));
        const adapter = new LegacyChatUtilityAdapter(createChatProvider({ rewriteQuery }));

        await expect(adapter.rewriteQuery({
            originalQuery: "original",
            conversationContext: "context",
            scopeDescription: "scope",
        })).resolves.toEqual({
            originalQuery: "original",
            rewrittenQuery: "rewritten",
            useRewrite: true,
        });
        expect(rewriteQuery).toHaveBeenCalledWith("original", "context", "scope");
    });

    it("preserves the memory extraction argument order and empty result", async () => {
        const extractMemoryStatements = vi.fn(async () => [] as string[]);
        const adapter = new LegacyChatUtilityAdapter(createChatProvider({ extractMemoryStatements }));

        await expect(adapter.extractMemoryStatements({
            conversationContext: "context",
            latestUserText: "user",
            latestAssistantText: "assistant",
        })).resolves.toEqual([]);
        expect(extractMemoryStatements).toHaveBeenCalledWith("context", "user", "assistant");
    });

    it("does not hide legacy provider failures before the application guard", async () => {
        const adapter = new LegacyChatUtilityAdapter(createChatProvider({
            rewriteQuery: async () => { throw new Error("legacy failed"); },
        }));

        await expect(adapter.rewriteQuery({
            originalQuery: "original",
            conversationContext: "context",
            scopeDescription: "scope",
        })).rejects.toThrow("legacy failed");
    });
});

function createChatProvider(overrides: Partial<ChatProvider>): ChatProvider {
    return {
        rewriteQuery: async (originalQuery) => ({ originalQuery, rewrittenQuery: originalQuery, useRewrite: false }),
        extractMemoryStatements: async () => [],
        generateMarkdownAnswer: async () => "",
        generateJsonAnswer: async () => "{}",
        streamMarkdownAnswer: async () => "",
        ...overrides,
    };
}
