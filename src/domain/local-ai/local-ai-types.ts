export type LocalAiRole = "embedding";
export type LocalAiPhase = "not-installed" | "downloading" | "loading" | "ready" | "error" | "clearing";

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

export interface LocalAIRuntimePort {
    getStatus(): LocalAiStatus;
    subscribe(listener: (status: LocalAiStatus) => void): () => void;
    prepare(allowDownload: boolean): Promise<void>;
    embed(request: LocalAiEmbeddingRequest): Promise<LocalAiEmbeddingResult>;
    clear(): Promise<void>;
    dispose(): Promise<void>;
}
