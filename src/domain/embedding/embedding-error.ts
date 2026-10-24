import type { EmbeddingProviderId } from "./embedding-provider";

export type EmbeddingErrorCode =
    | "invalid-request"
    | "auth"
    | "network"
    | "timeout"
    | "cancelled"
    | "unsupported-model"
    | "not-ready"
    | "malformed-response"
    | "dimension-mismatch"
    | "fingerprint-mismatch"
    | "unknown";

/** 跨 adapter 保持稳定的错误；UI 应根据 code 映射安全文案。 */
export class EmbeddingError extends Error {
    readonly code: EmbeddingErrorCode;
    readonly providerId: EmbeddingProviderId;
    readonly causeValue?: unknown;

    constructor(code: EmbeddingErrorCode, providerId: EmbeddingProviderId, message: string, causeValue?: unknown) {
        super(message);
        this.name = "EmbeddingError";
        this.code = code;
        this.providerId = providerId;
        this.causeValue = causeValue;
        Object.setPrototypeOf(this, EmbeddingError.prototype);
    }
}

export function isEmbeddingError(value: unknown): value is EmbeddingError {
    return value instanceof EmbeddingError;
}
