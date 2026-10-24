import path from "node:path";

/**
 * Node CLI 只提供质量和性能参考，使用官方 Node 入口及文件缓存。
 * Worker/WASM/CSP 证据必须来自独立 Obsidian smoke，不能用此结果代替。
 */
export async function createTransformersRuntime({ device, allowDownload, cacheDirectory }) {
    if (!["cpu", "webgpu"].includes(device)) throw new Error(`Node runtime 不支持设备：${device}`);
    assertSupportedNodeVersion();
    const transformers = await import("@huggingface/transformers");
    const requests = [];
    const originalFetch = globalThis.fetch.bind(globalThis);
    transformers.env.allowRemoteModels = allowDownload;
    transformers.env.allowLocalModels = true;
    transformers.env.useFS = true;
    transformers.env.useFSCache = true;
    transformers.env.useBrowserCache = false;
    transformers.env.useCustomCache = false;
    transformers.env.customCache = null;
    transformers.env.cacheDir = cacheDirectory;
    transformers.env.logLevel = transformers.LogLevel.WARNING;
    transformers.env.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        requests.push({ origin: url.origin, path: url.pathname });
        if (!allowDownload) {
            throw new Error(`离线验证检测到网络请求：${url.origin}${url.pathname}`);
        }
        return originalFetch(input, init);
    };
    return {
        ...transformers,
        requests,
        close: async () => undefined,
    };
}

function assertSupportedNodeVersion() {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 20 || (major === 20 && minor < 9)) {
        throw new Error(`M4 真实模型 CLI 需要 Node.js >= 20.9.0；当前为 ${process.version}。静态校验和 Obsidian smoke 构建仍可单独执行。`);
    }
}

export async function loadFeatureExtractor(runtime, candidate, device, allowDownload, progressCallback) {
    const cachedRevisionPath = path.join(runtime.env.cacheDir, candidate.repository, candidate.revision);
    const modelSource = allowDownload ? candidate.repository : cachedRevisionPath;
    const pretrainedOptions = {
        revision: allowDownload ? candidate.revision : "main",
        dtype: candidate.dtype,
        device,
        cache_dir: runtime.env.cacheDir,
        local_files_only: !allowDownload,
        progress_callback: progressCallback,
    };
    // Transformers.js 4.3.1 的 pipeline() 会在正式加载前调用 get_pipeline_files()，
    // 但该预扫描没有转发 revision、cache_dir 和 local_files_only。结果是联网时额外访问 main，
    // 离线时又可能误判 tokenizer.json 不存在，并构造 tokenizer=null 的 pipeline。
    // 离线运行进一步直接加载 revision 对应的本地目录，因为 AutoTokenizer 的文件发现同样不会
    // 转发 revision。该目录只包含已经按不可变 revision 下载并校验的资产。
    const [tokenizer, model] = await Promise.all([
        runtime.AutoTokenizer.from_pretrained(modelSource, pretrainedOptions),
        runtime.AutoModel.from_pretrained(modelSource, pretrainedOptions),
    ]);
    return new runtime.FeatureExtractionPipeline({
        task: candidate.task,
        model,
        tokenizer,
    });
}

export async function embedTexts(extractor, candidate, purpose, texts) {
    const prefix = candidate.prefixes[purpose];
    if (typeof prefix !== "string") throw new Error(`候选模型未定义 ${purpose} 前缀。`);
    const output = await extractor(texts.map((text) => `${prefix}${text}`), {
        pooling: candidate.pooling,
        normalize: candidate.normalize,
    });
    const vectors = output.tolist();
    output.dispose?.();
    validateVectors(vectors, texts.length, candidate.dimension);
    return vectors;
}

function validateVectors(vectors, expectedCount, expectedDimension) {
    if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
        throw new Error(`向量条数不匹配：${vectors?.length ?? "unknown"} != ${expectedCount}`);
    }
    for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== expectedDimension) {
            throw new Error(`向量维数不匹配：${vector?.length ?? "unknown"} != ${expectedDimension}`);
        }
        if (vector.some((value) => !Number.isFinite(value))) throw new Error("向量包含非有限数值。");
    }
}
