import { env, LogLevel, ModelRegistry, pipeline } from "@huggingface/transformers";

self.onmessage = async (event) => {
    if (event.data?.type !== "run") return;
    const config = event.data.payload;
    const requests = [];
    let extractor;
    try {
        const originalFetch = globalThis.fetch.bind(globalThis);
        env.allowRemoteModels = config.allowDownload;
        env.allowLocalModels = true;
        env.useFS = false;
        env.useFSCache = false;
        env.useBrowserCache = true;
        env.useCustomCache = false;
        env.useWasmCache = false;
        env.logLevel = LogLevel.WARNING;
        env.backends.onnx.wasm.wasmPaths = config.wasmPaths;
        env.fetch = async (input, init) => {
            const url = new URL(typeof input === "string" ? input : input.url);
            const localRuntimeRequest = url.href === config.wasmPaths.mjs || url.href === config.wasmPaths.wasm;
            requests.push({ origin: url.origin, path: url.pathname, localRuntimeRequest });
            if (!config.allowDownload && !localRuntimeRequest) {
                throw new Error(`Offline smoke detected a network request: ${url.origin}${url.pathname}`);
            }
            return originalFetch(input, init);
        };
        const registryOptions = {
            revision: config.revision,
            dtype: config.dtype,
            device: config.device,
            local_files_only: !config.allowDownload,
        };
        const requiredFiles = await ModelRegistry.get_pipeline_files(config.task, config.repository, registryOptions);
        const cachedBefore = await ModelRegistry.is_pipeline_cached(config.task, config.repository, registryOptions);
        const loadStartedAt = performance.now();
        extractor = await pipeline(config.task, config.repository, {
            ...registryOptions,
            progress_callback: (progress) => postMessage({ type: "progress", payload: sanitizeProgress(progress) }),
        });
        const loadMs = performance.now() - loadStartedAt;
        const inferenceStartedAt = performance.now();
        const output = await extractor([
            `${config.prefixes.query}offline cache verification`,
            `${config.prefixes.document}the model cache contains all required assets`,
        ], { pooling: config.pooling, normalize: config.normalize });
        const vectors = output.tolist();
        output.dispose?.();
        validateVectors(vectors, 2, config.dimension);
        const inferenceMs = performance.now() - inferenceStartedAt;
        await extractor.dispose?.();
        extractor = null;
        postMessage({
            type: "result",
            payload: {
                schemaVersion: 1,
                status: "pass",
                mode: config.allowDownload ? "download-allowed" : "offline-only",
                candidate: { repository: config.repository, revision: config.revision, dtype: config.dtype },
                runtime: {
                    transformersJs: env.version,
                    device: config.device,
                    worker: typeof globalThis.WorkerGlobalScope !== "undefined"
                        && self instanceof globalThis.WorkerGlobalScope,
                    secureContext: self.isSecureContext,
                    crossOriginIsolated: self.crossOriginIsolated,
                    webgpuApiAvailable: typeof navigator !== "undefined" && "gpu" in navigator,
                },
                metrics: { loadMs, inferenceMs, dimension: vectors[0].length },
                assets: {
                    requiredFiles,
                    cachedBefore,
                    cachedAfter: await ModelRegistry.is_pipeline_cached(config.task, config.repository, registryOptions),
                },
                requests,
            },
        });
    } catch (error) {
        await extractor?.dispose?.();
        postMessage({
            type: "result",
            payload: {
                schemaVersion: 1,
                status: "fail",
                mode: config.allowDownload ? "download-allowed" : "offline-only",
                runtime: { transformersJs: env.version, device: config.device },
                error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) },
                requests,
            },
        });
    }
};

function validateVectors(vectors, expectedCount, expectedDimension) {
    if (!Array.isArray(vectors) || vectors.length !== expectedCount) throw new Error("Worker returned the wrong vector count.");
    for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== expectedDimension) throw new Error("Worker returned an unexpected dimension.");
        if (vector.some((value) => !Number.isFinite(value))) throw new Error("Worker returned a non-finite vector.");
    }
}

function sanitizeProgress(progress) {
    return {
        status: progress.status,
        file: typeof progress.file === "string" ? progress.file.split("/").at(-1) : undefined,
        progress: Number.isFinite(progress.progress) ? progress.progress : undefined,
    };
}
