import type { VaultCoachSettings } from "../../app/config/settings-types";
import { EmbeddingError } from "../../domain/embedding/embedding-error";
import type { EmbeddingBatch, EmbeddingProvider, EmbeddingProviderDescriptor, EmbeddingRequest } from "../../domain/embedding/embedding-provider";
import { canonicalizeEndpointIdentity, type EmbeddingHttpTransport } from "./embedding-http-transport";
import { createEmbeddingBatch, mapEmbeddingFailure, validateEmbeddingRequest } from "./embedding-provider-utils";

interface OpenAiEmbeddingResponse {
    data?: Array<{ embedding?: number[]; index?: number }>;
    error?: { message?: string };
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly id = "openai-compatible" as const;

    constructor(
        private readonly getSettings: () => VaultCoachSettings,
        private readonly getApiKey: () => string | null,
        private readonly transport: EmbeddingHttpTransport,
    ) {}

    describe(): EmbeddingProviderDescriptor {
        const settings = this.getSettings();
        return {
            providerId: this.id,
            endpointIdentity: canonicalizeEndpointIdentity(settings.cloudEmbeddingBaseUrl),
            model: settings.cloudEmbeddingModel.trim(),
            revision: "unverified",
            modelDtype: "provider-defined",
            outputDtype: "float32",
            pooling: "provider-defined",
            normalization: "consumer-l2-v1",
            preprocessing: { document: "identity-v1", query: "identity-v1", graph: "identity-v1" },
            implementationVersion: 1,
        };
    }

    async embed(request: EmbeddingRequest): Promise<EmbeddingBatch> {
        validateEmbeddingRequest(request, this.id);
        const descriptor = this.describe();
        const apiKey = this.getApiKey();
        if (!descriptor.model) throw new EmbeddingError("invalid-request", this.id, "未配置云端 embedding 模型。");
        if (!apiKey) throw new EmbeddingError("auth", this.id, "未配置云端模型 API key。");
        const startedAt = Date.now();
        try {
            const settings = this.getSettings();
            const response = await this.transport.postJson({
                baseUrl: settings.cloudEmbeddingBaseUrl,
                path: getEmbeddingsPath(settings.cloudEmbeddingBaseUrl),
                payload: { model: settings.cloudEmbeddingModel, input: [...request.texts] },
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: request.signal,
            });
            request.signal?.throwIfAborted();
            const parsed = JSON.parse(response.text) as OpenAiEmbeddingResponse;
            if (parsed.error?.message) throw new EmbeddingError("unknown", this.id, parsed.error.message);
            const items = parsed.data ?? [];
            const ordered = items.every((item) => Number.isInteger(item.index))
                ? [...items].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
                : items;
            const vectors = ordered.map((item) => item.embedding ?? []);
            return createEmbeddingBatch(vectors, request.texts.length, descriptor, {
                providerId: this.id,
                transport: "openai-compatible",
                latencyMs: Date.now() - startedAt,
                attempts: 1,
                cpuFallbackUsed: false,
                revisionVerified: false,
            });
        } catch (error: unknown) {
            throw mapEmbeddingFailure(this.id, error);
        }
    }
}

function getEmbeddingsPath(baseUrl: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    if (normalized.endsWith("/embeddings")) return "";
    if (normalized.endsWith("/v1")) return "/embeddings";
    return "/v1/embeddings";
}
