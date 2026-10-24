import type { VaultCoachSettings } from "../../app/config/settings-types";
import { EmbeddingError } from "../../domain/embedding/embedding-error";
import type { EmbeddingBatch, EmbeddingProvider, EmbeddingProviderDescriptor, EmbeddingRequest } from "../../domain/embedding/embedding-provider";
import { canonicalizeEndpointIdentity, EmbeddingHttpTransportError, type EmbeddingHttpTransport } from "./embedding-http-transport";
import { createEmbeddingBatch, mapEmbeddingFailure, validateEmbeddingRequest } from "./embedding-provider-utils";

interface OllamaModernResponse { embeddings?: number[][]; error?: string; }
interface OllamaLegacyResponse { embedding?: number[]; error?: string; }

export class OllamaEmbeddingProvider implements EmbeddingProvider {
    readonly id = "ollama" as const;
    private preferCpu = false;

    constructor(
        private readonly getSettings: () => VaultCoachSettings,
        private readonly transport: EmbeddingHttpTransport,
    ) {}

    describe(): EmbeddingProviderDescriptor {
        const settings = this.getSettings();
        return {
            providerId: this.id,
            endpointIdentity: canonicalizeEndpointIdentity(settings.llmBaseUrl),
            model: settings.embeddingModel.trim(),
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
        if (!descriptor.model) throw new EmbeddingError("invalid-request", this.id, "未配置本地 embedding 模型。");
        const startedAt = Date.now();
        let attempts = 0;
        let cpuFallbackUsed = false;
        const invokeModern = async (cpu: boolean): Promise<number[][]> => {
            attempts += 1;
            const response = await this.transport.postJson({
                baseUrl: this.getSettings().llmBaseUrl,
                path: "/api/embed",
                payload: { model: this.getSettings().embeddingModel, input: [...request.texts], truncate: true,
                    ...(cpu ? { options: { num_gpu: 0 } } : {}) },
                signal: request.signal,
            });
            const parsed = JSON.parse(response.text) as OllamaModernResponse;
            if (parsed.error) throw new EmbeddingError("unknown", this.id, parsed.error);
            return parsed.embeddings ?? [];
        };
        const invokeLegacy = async (cpu: boolean): Promise<number[][]> => {
            const vectors: number[][] = [];
            for (const text of request.texts) {
                attempts += 1;
                const response = await this.transport.postJson({
                    baseUrl: this.getSettings().llmBaseUrl,
                    path: "/api/embeddings",
                    payload: { model: this.getSettings().embeddingModel, prompt: text,
                        ...(cpu ? { options: { num_gpu: 0 } } : {}) },
                    signal: request.signal,
                });
                const parsed = JSON.parse(response.text) as OllamaLegacyResponse;
                if (parsed.error) throw new EmbeddingError("unknown", this.id, parsed.error);
                vectors.push(parsed.embedding ?? []);
            }
            return vectors;
        };
        let transport: "ollama-modern" | "ollama-legacy" = "ollama-modern";
        try {
            let vectors: number[][];
            try {
                vectors = await invokeModern(this.preferCpu);
            } catch (error: unknown) {
                if (!this.preferCpu && shouldRetryOnCpu(error)) {
                    vectors = await invokeModern(true);
                    this.preferCpu = true;
                    cpuFallbackUsed = true;
                } else if (isNotFound(error)) {
                    transport = "ollama-legacy";
                    try {
                        vectors = await invokeLegacy(this.preferCpu);
                    } catch (legacyError: unknown) {
                        if (!this.preferCpu && shouldRetryOnCpu(legacyError)) {
                            vectors = await invokeLegacy(true);
                            this.preferCpu = true;
                            cpuFallbackUsed = true;
                        } else throw legacyError;
                    }
                } else throw error;
            }
            request.signal?.throwIfAborted();
            return createEmbeddingBatch(vectors, request.texts.length, descriptor, {
                providerId: this.id, transport, latencyMs: Date.now() - startedAt, attempts,
                cpuFallbackUsed, revisionVerified: false,
            });
        } catch (error: unknown) {
            throw mapEmbeddingFailure(this.id, error);
        }
    }
}

function isNotFound(error: unknown): boolean {
    return error instanceof EmbeddingHttpTransportError && error.status === 404;
}

function shouldRetryOnCpu(error: unknown): boolean {
    if (!(error instanceof EmbeddingHttpTransportError) || error.status === null || error.status < 500) return false;
    return /cuda|gpu|ptx|ggml|runner|backend/i.test(error.message);
}
