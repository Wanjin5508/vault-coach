import { EmbeddingError } from "./embedding-error";
import type { EmbeddingFingerprint, EmbeddingProviderDescriptor } from "./embedding-provider";

type CanonicalEmbeddingFingerprint = {
    providerId: EmbeddingFingerprint["providerId"];
    endpointIdentity: string;
    model: string;
    revision: string;
    modelDtype: string;
    outputDtype: EmbeddingFingerprint["outputDtype"];
    pooling: string;
    normalization: string;
    preprocessing: EmbeddingFingerprint["preprocessing"];
    implementationVersion: number;
    dimension: number;
};

/** 创建并校验一次成功推理对应的完整空间身份。 */
export function createEmbeddingFingerprint(
    descriptor: EmbeddingProviderDescriptor,
    dimension: number,
): EmbeddingFingerprint {
    const fingerprint: EmbeddingFingerprint = { ...descriptor, preprocessing: { ...descriptor.preprocessing }, dimension };
    validateEmbeddingFingerprint(fingerprint);
    return fingerprint;
}

/** 用固定字段顺序生成兼容比较所需的 canonical JSON。 */
export function canonicalizeEmbeddingFingerprint(fingerprint: EmbeddingFingerprint): string {
    validateEmbeddingFingerprint(fingerprint);
    const canonical: CanonicalEmbeddingFingerprint = {
        providerId: fingerprint.providerId,
        endpointIdentity: fingerprint.endpointIdentity,
        model: fingerprint.model,
        revision: fingerprint.revision,
        modelDtype: fingerprint.modelDtype,
        outputDtype: fingerprint.outputDtype,
        pooling: fingerprint.pooling,
        normalization: fingerprint.normalization,
        preprocessing: {
            document: fingerprint.preprocessing.document,
            query: fingerprint.preprocessing.query,
            graph: fingerprint.preprocessing.graph,
        },
        implementationVersion: fingerprint.implementationVersion,
        dimension: fingerprint.dimension,
    };
    return JSON.stringify(canonical);
}

export function areEmbeddingFingerprintsEqual(left: EmbeddingFingerprint, right: EmbeddingFingerprint): boolean {
    return canonicalizeEmbeddingFingerprint(left) === canonicalizeEmbeddingFingerprint(right);
}

export function isFingerprintCompatibleWithDescriptor(
    stored: EmbeddingFingerprint,
    current: EmbeddingProviderDescriptor,
): boolean {
    try {
        return canonicalizeDescriptor(stored) === canonicalizeDescriptor(current);
    } catch {
        return false;
    }
}

/** 短 ID 只用于诊断和界面，不能替代完整 JSON 兼容比较。 */
export function getEmbeddingFingerprintDisplayId(fingerprint: EmbeddingFingerprint): string {
    const value: string = canonicalizeEmbeddingFingerprint(fingerprint);
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function validateEmbeddingFingerprint(fingerprint: EmbeddingFingerprint): void {
    validateDescriptor(fingerprint);
    if (!Number.isInteger(fingerprint.dimension) || fingerprint.dimension <= 0) {
        throw new EmbeddingError("invalid-request", fingerprint.providerId, "Embedding dimension must be a positive integer.");
    }
}

function canonicalizeDescriptor(descriptor: EmbeddingProviderDescriptor): string {
    validateDescriptor(descriptor);
    return JSON.stringify({
        providerId: descriptor.providerId,
        endpointIdentity: descriptor.endpointIdentity,
        model: descriptor.model,
        revision: descriptor.revision,
        modelDtype: descriptor.modelDtype,
        outputDtype: descriptor.outputDtype,
        pooling: descriptor.pooling,
        normalization: descriptor.normalization,
        preprocessing: {
            document: descriptor.preprocessing.document,
            query: descriptor.preprocessing.query,
            graph: descriptor.preprocessing.graph,
        },
        implementationVersion: descriptor.implementationVersion,
    });
}

function validateDescriptor(descriptor: EmbeddingProviderDescriptor): void {
    const required = [descriptor.endpointIdentity, descriptor.model, descriptor.revision, descriptor.modelDtype,
        descriptor.pooling, descriptor.normalization, descriptor.preprocessing.document,
        descriptor.preprocessing.query, descriptor.preprocessing.graph];
    if (required.some((value) => value.trim().length === 0) || !Number.isInteger(descriptor.implementationVersion)
        || descriptor.implementationVersion <= 0) {
        throw new EmbeddingError("invalid-request", descriptor.providerId, "Embedding descriptor is incomplete.");
    }
}
