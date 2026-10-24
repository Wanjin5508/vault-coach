/** 当前插件版本允许获取的单个本地推理运行时资产。 */
export interface RuntimeArtifactPolicy {
    file: string;
    urls: readonly string[];
    bytes: number;
    sha256: string;
    mediaType: string;
}

/** 构建期从 lockfile 中实际安装的 ONNX Runtime 生成，禁止使用 latest URL。 */
export interface LocalAiRuntimePolicy {
    id: string;
    engine: "onnxruntime-web";
    version: string;
    backend: "wasm";
    cacheName: string;
    artifact: RuntimeArtifactPolicy;
}

export interface PreparedRuntimeAssets {
    policyId: string;
    wasmBinary: ArrayBuffer;
    source: "cache" | "download";
}

export interface RuntimeAssetProgress {
    artifact: "runtime-wasm";
    loadedBytes: number;
    totalBytes: number;
}

export interface PrepareRuntimeAssetsOptions {
    allowDownload: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: RuntimeAssetProgress) => void;
}

/** LocalAIRuntime 只依赖此窄端口，不感知 Obsidian 网络 API 或 Cache Storage。 */
export interface RuntimeAssetStore {
    prepare(options: PrepareRuntimeAssetsOptions): Promise<PreparedRuntimeAssets>;
    clear(): Promise<void>;
}

export interface RuntimeBinaryCache {
    read(key: string): Promise<ArrayBuffer | null>;
    write(key: string, value: ArrayBuffer, mediaType: string): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
}

export interface RuntimeAssetDownloader {
    download(url: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}
