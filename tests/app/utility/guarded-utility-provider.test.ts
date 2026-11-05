import { describe, expect, it, vi } from "vitest";
import { GuardedUtilityProvider } from "../../../src/app/utility/guarded-utility-provider";
import type { MemoryExtractionPort } from "../../../src/domain/utility/memory-extraction-port";
import type { QueryRewritePort, QueryRewriteRequest } from "../../../src/domain/utility/query-rewrite-port";

describe("GuardedUtilityProvider", () => {
    it("passes through valid bounded results", async () => {
        const provider = createProvider(
            { rewriteQuery: async ({ originalQuery }) => ({
                originalQuery,
                rewrittenQuery: "  improved query  ",
                useRewrite: true,
            }) },
            { extractMemoryStatements: async () => ["  durable fact  "] },
        );

        await expect(provider.rewriteQuery(createRewriteRequest())).resolves.toEqual({
            originalQuery: "query",
            rewrittenQuery: "improved query",
            useRewrite: true,
        });
        await expect(provider.extractMemoryStatements(createMemoryRequest())).resolves.toEqual(["durable fact"]);
    });

    it("isolates provider failures without exposing request text to diagnostics", async () => {
        const events: unknown[] = [];
        const provider = createProvider(
            { rewriteQuery: async () => { throw new Error("private query"); } },
            { extractMemoryStatements: async () => { throw new Error("private conversation"); } },
            (event) => events.push(event),
        );

        await expect(provider.rewriteQuery(createRewriteRequest())).resolves.toEqual({
            originalQuery: "query",
            rewrittenQuery: "query",
            useRewrite: false,
        });
        await expect(provider.extractMemoryStatements(createMemoryRequest())).resolves.toEqual([]);
        expect(events).toEqual([
            { task: "query-rewrite", reason: "provider-failed" },
            { task: "memory-extraction", reason: "provider-failed" },
        ]);
        expect(JSON.stringify(events)).not.toContain("private");
    });

    it("falls back on malformed typed output and classifies it separately", async () => {
        const events: unknown[] = [];
        const provider = createProvider(
            { rewriteQuery: async () => ({
                originalQuery: "wrong",
                rewrittenQuery: "invented",
                useRewrite: true,
            }) },
            { extractMemoryStatements: async () => ["same", " SAME "] },
            (event) => events.push(event),
        );

        await expect(provider.rewriteQuery(createRewriteRequest())).resolves.toMatchObject({ useRewrite: false });
        await expect(provider.extractMemoryStatements(createMemoryRequest())).resolves.toEqual([]);
        expect(events).toEqual([
            { task: "query-rewrite", reason: "invalid-output" },
            { task: "memory-extraction", reason: "invalid-output" },
        ]);
    });

    it("preserves cancellation before and during provider execution", async () => {
        const rewrite = vi.fn(async ({ originalQuery }: QueryRewriteRequest) => ({
            originalQuery,
            rewrittenQuery: originalQuery,
            useRewrite: false,
        }));
        const provider = createProvider(
            { rewriteQuery: rewrite },
            { extractMemoryStatements: async () => { throw new DOMException("cancelled", "AbortError"); } },
        );
        const controller = new AbortController();
        controller.abort();

        await expect(provider.rewriteQuery({ ...createRewriteRequest(), signal: controller.signal }))
            .rejects.toMatchObject({ name: "AbortError" });
        expect(rewrite).not.toHaveBeenCalled();
        await expect(provider.extractMemoryStatements(createMemoryRequest()))
            .rejects.toMatchObject({ name: "AbortError" });
    });

    it("does not let a diagnostic callback break fallback", async () => {
        const provider = createProvider(
            { rewriteQuery: async () => { throw new Error("failed"); } },
            { extractMemoryStatements: async () => [] },
            () => { throw new Error("observer failed"); },
        );

        await expect(provider.rewriteQuery(createRewriteRequest())).resolves.toMatchObject({
            rewrittenQuery: "query",
            useRewrite: false,
        });
    });
});

function createProvider(
    queryRewrite: QueryRewritePort,
    memoryExtraction: MemoryExtractionPort,
    onFailure?: ConstructorParameters<typeof GuardedUtilityProvider>[3],
): GuardedUtilityProvider {
    return new GuardedUtilityProvider(queryRewrite, memoryExtraction, undefined, onFailure);
}

function createRewriteRequest() {
    return { originalQuery: "query", conversationContext: "private conversation", scopeDescription: "vault" };
}

function createMemoryRequest() {
    return {
        conversationContext: "private conversation",
        latestUserText: "private user text",
        latestAssistantText: "private assistant text",
    };
}
