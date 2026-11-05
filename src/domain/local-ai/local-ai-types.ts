export type LocalAiRole = "embedding" | "reranker";
export type LocalAiPhase = "not-installed" | "downloading" | "loading" | "ready" | "evicted" | "error" | "clearing";

export interface LocalAiStatus {
    role: LocalAiRole;
    phase: LocalAiPhase;
    progress: number | null;
    message: string | null;
    cached: boolean;
    backend: "wasm";
}

export interface LocalAiEmbeddingRequest {
    texts: readonly string[];
    purpose: "document" | "query" | "graph";
    signal?: AbortSignal;
}

export interface LocalAiEmbeddingResult {
    vectors: number[][];
    latencyMs: number;
}

export interface LocalAiRerankCandidate {
    id: string;
    text: string;
}

export interface LocalAiRerankRequest {
    query: string;
    candidates: readonly LocalAiRerankCandidate[];
    signal?: AbortSignal;
}

export interface LocalAiRerankResult {
    scores: Array<{ candidateId: string; score: number }>;
    latencyMs: number;
    truncatedCandidateCount: number;
}

export interface LocalAIRuntimePort {
    getStatus(): LocalAiStatus;
    subscribe(listener: (status: LocalAiStatus) => void): () => void;
    prepare(allowDownload: boolean): Promise<void>;
    embed(request: LocalAiEmbeddingRequest): Promise<LocalAiEmbeddingResult>;
    hardCancel(): void;
    clear(): Promise<void>;
    dispose(): Promise<void>;
}

/** M6.1 使用的窄运行时端口；与 Embedding 共享 Worker、资产运行时和调度器。 */
export interface LocalAIRerankerRuntimePort {
    getRerankerStatus(): LocalAiStatus;
    prepareReranker(allowDownload: boolean): Promise<void>;
    rerank(request: LocalAiRerankRequest): Promise<LocalAiRerankResult>;
    clearReranker(): Promise<void>;
}
