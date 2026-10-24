import type { LocalAIRuntimePort } from "../../domain/local-ai/local-ai-types";
import type { EmbeddingBatch, EmbeddingProvider, EmbeddingProviderDescriptor, EmbeddingRequest } from "../../domain/embedding/embedding-provider";
import { createEmbeddingBatch, mapEmbeddingFailure, validateEmbeddingRequest } from "./embedding-provider-utils";
import { BUILTIN_EMBEDDING_POLICY } from "../../app/local-ai/model-registry";

/** 将统一 LocalAIRuntime 适配为 RAG 可消费的窄 EmbeddingProvider。 */
export class BuiltinEmbeddingProvider implements EmbeddingProvider {
    readonly id = "builtin" as const;

    constructor(private readonly runtime: LocalAIRuntimePort) {}

    describe(): EmbeddingProviderDescriptor {
        return {
            providerId: this.id,
            endpointIdentity: `local-ai:${BUILTIN_EMBEDDING_POLICY.id}`,
            model: BUILTIN_EMBEDDING_POLICY.repository,
            revision: BUILTIN_EMBEDDING_POLICY.revision,
            modelDtype: BUILTIN_EMBEDDING_POLICY.dtype,
            outputDtype: "float32",
            pooling: BUILTIN_EMBEDDING_POLICY.pooling,
            normalization: "l2",
            preprocessing: { ...BUILTIN_EMBEDDING_POLICY.prefixes },
            implementationVersion: 1,
        };
    }

    async embed(request: EmbeddingRequest): Promise<EmbeddingBatch> {
        validateEmbeddingRequest(request, this.id);
        const startedAt = performance.now();
        try {
            const result = await this.runtime.embed(request);
            return createEmbeddingBatch(result.vectors, request.texts.length, this.describe(), {
                providerId: this.id,
                transport: "builtin-worker-wasm",
                latencyMs: result.latencyMs || performance.now() - startedAt,
                attempts: 1,
                cpuFallbackUsed: false,
                revisionVerified: true,
            });
        } catch (error) {
            throw mapEmbeddingFailure(this.id, error);
        }
    }
}
