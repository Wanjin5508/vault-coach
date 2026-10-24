import { createEmbeddingFingerprint } from "../../domain/embedding/embedding-fingerprint";
import { EmbeddingError, isEmbeddingError } from "../../domain/embedding/embedding-error";
import type {
    EmbeddingBatch,
    EmbeddingDiagnostics,
    EmbeddingProviderDescriptor,
    EmbeddingProviderId,
    EmbeddingRequest,
} from "../../domain/embedding/embedding-provider";
import { EmbeddingHttpTransportError } from "./embedding-http-transport";

export function validateEmbeddingRequest(request: EmbeddingRequest, providerId: EmbeddingProviderId): void {
    if (request.texts.length === 0 || request.texts.some((text) => typeof text !== "string")) {
        throw new EmbeddingError("invalid-request", providerId, "Embedding request must contain at least one text.");
    }
    if (request.signal?.aborted) throw new EmbeddingError("cancelled", providerId, "Embedding request was cancelled.");
}

export function createEmbeddingBatch(
    rawVectors: readonly (readonly number[])[],
    expectedCount: number,
    descriptor: EmbeddingProviderDescriptor,
    diagnostics: EmbeddingDiagnostics,
): EmbeddingBatch {
    if (rawVectors.length !== expectedCount || rawVectors.length === 0) {
        throw new EmbeddingError("malformed-response", descriptor.providerId, "Embedding response count does not match request count.");
    }
    const dimension = rawVectors[0]?.length ?? 0;
    if (dimension <= 0) throw new EmbeddingError("malformed-response", descriptor.providerId, "Embedding response is empty.");
    const vectors = rawVectors.map((raw) => {
        if (raw.length !== dimension) {
            throw new EmbeddingError("dimension-mismatch", descriptor.providerId, "Embedding response contains inconsistent dimensions.");
        }
        const vector = new Float32Array(raw);
        if (Array.from(vector).some((value) => !Number.isFinite(value))) {
            throw new EmbeddingError("malformed-response", descriptor.providerId, "Embedding response contains a non-finite value.");
        }
        return vector;
    });
    return { vectors, fingerprint: createEmbeddingFingerprint(descriptor, dimension), diagnostics };
}

export function mapEmbeddingFailure(providerId: EmbeddingProviderId, error: unknown): EmbeddingError {
    if (isEmbeddingError(error)) return error;
    if (error instanceof DOMException && error.name === "AbortError") {
        return new EmbeddingError("cancelled", providerId, "Embedding request was cancelled.", error);
    }
    if (error instanceof SyntaxError) {
        return new EmbeddingError("malformed-response", providerId, "Embedding response is not valid JSON.", error);
    }
    if (error instanceof EmbeddingHttpTransportError) {
        const code = error.status === 401 || error.status === 403
            ? "auth"
            : error.status === 404 ? "unsupported-model" : error.status === null ? "network" : "unknown";
        return new EmbeddingError(code, providerId, error.message, error);
    }
    return new EmbeddingError("unknown", providerId, "Embedding request failed.", error);
}
