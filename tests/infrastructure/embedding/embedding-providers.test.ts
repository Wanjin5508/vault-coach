import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../../../src/settings";
import { EmbeddingHttpTransportError, type EmbeddingHttpRequest, type EmbeddingHttpResponse, type EmbeddingHttpTransport } from "../../../src/infrastructure/embedding/embedding-http-transport";
import { OllamaEmbeddingProvider } from "../../../src/infrastructure/embedding/ollama-embedding-provider";
import { OpenAiCompatibleEmbeddingProvider } from "../../../src/infrastructure/embedding/openai-compatible-embedding-provider";
import { EmbeddingProviderRouter } from "../../../src/app/embedding/embedding-provider-router";
import type { VaultCoachSettings } from "../../../src/app/config/settings-types";

class FakeTransport implements EmbeddingHttpTransport {
    readonly requests: EmbeddingHttpRequest[] = [];
    constructor(private readonly responses: Array<EmbeddingHttpResponse | Error>) {}
    async postJson(request: EmbeddingHttpRequest): Promise<EmbeddingHttpResponse> {
        this.requests.push(request);
        const response = this.responses.shift();
        if (!response) throw new Error("Missing fake response.");
        if (response instanceof Error) throw response;
        return response;
    }
}

describe("embedding provider adapters", () => {
    it("selects the active provider at call time without caching an old settings snapshot", async () => {
        let settings: VaultCoachSettings = createDefaultSettings();
        const ollama = new OllamaEmbeddingProvider(() => settings,
            new FakeTransport([{ status: 200, text: JSON.stringify({ embeddings: [[1, 0]] }) }]));
        const cloud = new OpenAiCompatibleEmbeddingProvider(() => settings, () => "secret",
            new FakeTransport([{ status: 200, text: JSON.stringify({ data: [{ embedding: [0, 1] }] }) }]));
        const router = new EmbeddingProviderRouter(() => settings, [ollama, cloud]);
        expect((await router.embed({ texts: ["one"], purpose: "query" })).diagnostics.providerId).toBe("ollama");
        settings = { ...settings, embeddingProvider: "openai-compatible", cloudEmbeddingModel: "embed" };
        expect((await router.embed({ texts: ["two"], purpose: "query" })).diagnostics.providerId).toBe("openai-compatible");
    });

    it("uses one bounded Ollama CPU fallback and reports diagnostics", async () => {
        const settings = createDefaultSettings();
        const transport = new FakeTransport([
            new EmbeddingHttpTransportError(500, "CUDA backend failed"),
            { status: 200, text: JSON.stringify({ embeddings: [[1, 2]] }) },
            { status: 200, text: JSON.stringify({ embeddings: [[3, 4]] }) },
        ]);
        const provider = new OllamaEmbeddingProvider(() => settings, transport);

        const first = await provider.embed({ texts: ["one"], purpose: "query" });
        const second = await provider.embed({ texts: ["two"], purpose: "query" });

        expect(first.diagnostics).toMatchObject({ attempts: 2, cpuFallbackUsed: true, transport: "ollama-modern" });
        expect((transport.requests[1]?.payload as { options?: unknown }).options).toEqual({ num_gpu: 0 });
        expect((transport.requests[2]?.payload as { options?: unknown }).options).toEqual({ num_gpu: 0 });
        expect(second.vectors[0]).toEqual(new Float32Array([3, 4]));
    });

    it("falls back from modern Ollama 404 to the legacy per-text endpoint", async () => {
        const settings = createDefaultSettings();
        const transport = new FakeTransport([
            new EmbeddingHttpTransportError(404, "not found"),
            { status: 200, text: JSON.stringify({ embedding: [1, 0] }) },
            { status: 200, text: JSON.stringify({ embedding: [0, 1] }) },
        ]);
        const provider = new OllamaEmbeddingProvider(() => settings, transport);
        const batch = await provider.embed({ texts: ["one", "two"], purpose: "document" });
        expect(batch.diagnostics).toMatchObject({ attempts: 3, transport: "ollama-legacy" });
        expect(transport.requests.map((request) => request.path)).toEqual(["/api/embed", "/api/embeddings", "/api/embeddings"]);
    });

    it("keeps OpenAI-compatible ordering and rejects partial batches", async () => {
        const settings = { ...createDefaultSettings(), embeddingProvider: "openai-compatible" as const,
            cloudEmbeddingModel: "embed", cloudEmbeddingBaseUrl: "https://user:pass@example.test/v1?secret=yes" };
        const good = new FakeTransport([{ status: 200, text: JSON.stringify({ data: [
            { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
        ] }) }]);
        const provider = new OpenAiCompatibleEmbeddingProvider(() => settings, () => "secret", good);
        const batch = await provider.embed({ texts: ["one", "two"], purpose: "document" });
        expect(batch.vectors[0]).toEqual(new Float32Array([1, 0]));
        expect(batch.fingerprint.endpointIdentity).toBe("https://example.test/v1");
        expect(JSON.stringify(batch.fingerprint)).not.toContain("secret");

        const partial = new OpenAiCompatibleEmbeddingProvider(() => settings, () => "secret",
            new FakeTransport([{ status: 200, text: JSON.stringify({ data: [{ embedding: [1, 0] }] }) }]));
        await expect(partial.embed({ texts: ["one", "two"], purpose: "document" })).rejects.toMatchObject({ code: "malformed-response" });
    });
});
