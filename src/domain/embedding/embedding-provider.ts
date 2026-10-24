/** Vault Coach 当前支持的 embedding 实现标识。磁盘设置值必须保持稳定。 */
export type EmbeddingProviderId = "ollama" | "openai-compatible" | "builtin";

/** 同一模型可以针对文档、查询和图谱使用不同的输入前缀。 */
export type EmbeddingPurpose = "document" | "query" | "graph";

export interface EmbeddingPreprocessingDescriptor {
    // ? why
    document: string;
    query: string;
    graph: string;
}

/**
 * 描述会影响向量语义空间的静态配置。
 *
 * 该对象不得包含 API key、用户文本或可随单次请求变化的诊断数据。
 */
export interface EmbeddingProviderDescriptor {
    providerId: EmbeddingProviderId;
    endpointIdentity: string;
    model: string;
    revision: string;
    modelDtype: string;
    outputDtype: "float32";
    pooling: string;
    normalization: string;
    preprocessing: EmbeddingPreprocessingDescriptor;
    implementationVersion: number;
}

/** 完整向量空间身份；维数只有在一次成功推理后才能确定。 */
export interface EmbeddingFingerprint extends EmbeddingProviderDescriptor {
    dimension: number;
}

export interface EmbeddingRequest {
    texts: readonly string[];
    purpose: EmbeddingPurpose;
    signal?: AbortSignal;
}

export interface EmbeddingDiagnostics {
    providerId: EmbeddingProviderId;
    transport: "ollama-modern" | "ollama-legacy" | "openai-compatible" | "builtin-worker-wasm";
    latencyMs: number;
    attempts: number;
    cpuFallbackUsed: boolean;
    revisionVerified: boolean;
}

export interface EmbeddingBatch {
    vectors: readonly Float32Array[];
    fingerprint: EmbeddingFingerprint;
    diagnostics: EmbeddingDiagnostics;
}

/** 上层唯一可见的 embedding 端口。 */
export interface EmbeddingProvider {
    readonly id: EmbeddingProviderId;
    describe(): EmbeddingProviderDescriptor;
    embed(request: EmbeddingRequest): Promise<EmbeddingBatch>;
}
