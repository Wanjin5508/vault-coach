import { describe, expect, it } from "vitest";
import { resolveRetrievalMode, resolveVectorFailure } from "../../../src/app/retrieval/retrieval-mode-resolver";

describe("resolveRetrievalMode", () => {
    it("uses hybrid for auto when vector retrieval is ready", () => {
        expect(resolveRetrievalMode("auto", { vectorEnabled: true, vectorReady: true })).toEqual({
            preference: "auto",
            resolvedMode: "hybrid",
            reason: "vector-ready",
        });
    });

    it("falls back to keyword when vector retrieval is unavailable", () => {
        expect(resolveRetrievalMode("auto", { vectorEnabled: true, vectorReady: false })).toEqual({
            preference: "auto",
            resolvedMode: "keyword",
            reason: "vector-unavailable",
        });
    });

    it("preserves explicit modes and records runtime vector failures", () => {
        expect(resolveRetrievalMode("keyword", { vectorEnabled: true, vectorReady: true }).reason).toBe("explicit");
        expect(resolveRetrievalMode("vector", { vectorEnabled: true, vectorReady: true }).resolvedMode).toBe("vector");
        expect(resolveVectorFailure("vector")).toEqual({
            preference: "vector",
            resolvedMode: "keyword",
            reason: "vector-failed",
        });
    });
});
