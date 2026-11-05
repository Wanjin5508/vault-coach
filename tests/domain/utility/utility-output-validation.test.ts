import { describe, expect, it } from "vitest";
import {
    DEFAULT_UTILITY_OUTPUT_LIMITS,
    parseMemoryExtractionOutput,
    parseQueryRewriteOutput,
    parseUtilityJson,
    UtilityOutputValidationError,
    validateMemoryStatements,
    validateQueryRewriteResult,
} from "../../../src/domain/utility/utility-output-validation";

describe("utility output validation", () => {
    it("parses an exact query rewrite schema and derives the rewrite flag", () => {
        expect(parseQueryRewriteOutput('{"rewritten_query":"  Obsidian vector search  "}', "vector search"))
            .toEqual({
                originalQuery: "vector search",
                rewrittenQuery: "Obsidian vector search",
                useRewrite: true,
            });
        expect(parseQueryRewriteOutput('{"rewritten_query":"same"}', "same")).toEqual({
            originalQuery: "same",
            rewrittenQuery: "same",
            useRewrite: false,
        });
    });

    it("rejects wrappers, non-object roots, missing fields, and extra fields", () => {
        expectValidationCode(() => parseUtilityJson("```json\n{}\n```"), "invalid-json");
        expectValidationCode(() => parseQueryRewriteOutput("[]", "query"), "invalid-shape");
        expectValidationCode(() => parseQueryRewriteOutput("{}", "query"), "invalid-shape");
        expectValidationCode(
            () => parseQueryRewriteOutput('{"rewritten_query":"query","explanation":"text"}', "query"),
            "unexpected-field",
        );
    });

    it("rejects empty or over-budget rewrite text", () => {
        expectValidationCode(() => parseQueryRewriteOutput('{"rewritten_query":"  "}', "query"), "empty-value");
        const longQuery = "x".repeat(DEFAULT_UTILITY_OUTPUT_LIMITS.rewrittenQueryCharacters + 1);
        expectValidationCode(
            () => parseQueryRewriteOutput(JSON.stringify({ rewritten_query: longQuery }), "query"),
            "limit-exceeded",
        );
    });

    it("parses bounded unique memory statements and preserves an empty result", () => {
        expect(parseMemoryExtractionOutput('{"memories":["  Uses Obsidian  ","Learning German"]}'))
            .toEqual(["Uses Obsidian", "Learning German"]);
        expect(parseMemoryExtractionOutput('{"memories":[]}')).toEqual([]);
    });

    it("rejects partial, duplicate, over-count, and over-length memory output", () => {
        expectValidationCode(() => parseMemoryExtractionOutput('{"memories":["valid",3]}'), "invalid-shape");
        expectValidationCode(() => validateMemoryStatements(["Same fact", " same   fact "]), "duplicate-value");
        expectValidationCode(
            () => validateMemoryStatements(Array.from(
                { length: DEFAULT_UTILITY_OUTPUT_LIMITS.memoryStatements + 1 },
                (_, index) => `fact-${index}`,
            )),
            "limit-exceeded",
        );
        expectValidationCode(
            () => validateMemoryStatements([
                "x".repeat(DEFAULT_UTILITY_OUTPUT_LIMITS.memoryStatementCharacters + 1),
            ]),
            "limit-exceeded",
        );
    });

    it("validates typed provider results instead of trusting TypeScript declarations", () => {
        expect(validateQueryRewriteResult({
            originalQuery: "query",
            rewrittenQuery: "  better query  ",
            useRewrite: true,
        }, "query")).toEqual({
            originalQuery: "query",
            rewrittenQuery: "better query",
            useRewrite: true,
        });
        expectValidationCode(() => validateQueryRewriteResult({
            originalQuery: "different",
            rewrittenQuery: "query",
            useRewrite: false,
        }, "query"), "invalid-shape");
        expectValidationCode(() => validateQueryRewriteResult({
            originalQuery: "query",
            rewrittenQuery: "changed",
            useRewrite: false,
        }, "query"), "invalid-shape");
    });
});

function expectValidationCode(action: () => unknown, code: string): void {
    try {
        action();
        throw new Error("Expected utility validation to fail.");
    } catch (error: unknown) {
        expect(error).toBeInstanceOf(UtilityOutputValidationError);
        expect(error).toMatchObject({ code });
    }
}
