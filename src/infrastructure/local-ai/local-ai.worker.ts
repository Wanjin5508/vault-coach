import {
    AutoModel,
    env,
    FeatureExtractionPipeline,
    LogLevel,
    XLMRobertaTokenizer,
} from "@huggingface/transformers";
import { BUILTIN_EMBEDDING_POLICY } from "../../app/local-ai/model-registry";

declare const __VAULT_COACH_ORT_WASM_BASE64__: string;

const policy = BUILTIN_EMBEDDING_POLICY;
const requiredFiles = Object.values(policy.files);

const cacheName = "vault-coach-local-ai-v1";
let extractor: FeatureExtractionPipeline | null = null;
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<unknown>) => {
    queue = queue.then(() => handleMessage(parseRequest(event.data))).catch((error: unknown) => {
        postMessage({ type: "fatal", error: serializeError(error) });
    });
};

async function handleMessage(message: { id: string; type: string; payload?: Record<string, unknown> }): Promise<void> {
    try {
        if (message.type === "prepare") {
            await prepare(Boolean(message.payload?.allowDownload));
            respond(message.id, { ready: true });
            return;
        }
        if (message.type === "embed") {
            if (!extractor) throw new Error("Built-in embedding model is not ready. Run the prepare command first.");
            const texts = Array.isArray(message.payload?.texts) ? message.payload.texts.map(String) : [];
            const purpose = String(message.payload?.purpose) as keyof typeof policy.prefixes;
            const prefix = policy.prefixes[purpose];
            if (!prefix || texts.length === 0) throw new Error("Invalid built-in embedding request.");
            const startedAt = performance.now();
            const output = await extractor(texts.map((text) => `${prefix}${text}`), {
                pooling: policy.pooling,
                normalize: policy.normalize,
            });
            const vectors = output.tolist() as number[][];
            output.dispose?.();
            validateVectors(vectors, texts.length);
            respond(message.id, { vectors, latencyMs: performance.now() - startedAt });
            return;
        }
        if (message.type === "clear") {
            await extractor?.dispose?.();
            extractor = null;
            await caches.delete(cacheName);
            respond(message.id, { cleared: true });
            return;
        }
        if (message.type === "dispose") {
            await extractor?.dispose?.();
            extractor = null;
            respond(message.id, { disposed: true });
            close();
            return;
        }
        throw new Error(`Unknown local AI worker message: ${message.type}`);
    } catch (error) {
        postMessage({ type: "response", id: message.id, ok: false, error: serializeError(error) });
    }
}

async function prepare(allowDownload: boolean): Promise<void> {
    if (extractor) return;
    configureRuntime();
    const cache = await caches.open(cacheName);
    for (let index = 0; index < requiredFiles.length; index += 1) {
        const file = requiredFiles[index]!;
        const url = assetUrl(file);
        const cachedResponse = await cache.match(url);
        let bytes: Uint8Array;
        if (!cachedResponse) {
            if (!allowDownload) throw new Error("Built-in embedding assets are not installed. Run the prepare command while online.");
            postMessage({ type: "progress", progress: index / requiredFiles.length, file });
            // Dedicated Worker 无法导入 Obsidian requestUrl；这里只下载用户明确同意的固定版本资产。
            const response = await globalThis.fetch(url, { cache: "no-store" });
            if (!response.ok) throw new Error(`Model asset download failed (${response.status}): ${file}`);
            bytes = new Uint8Array(await response.arrayBuffer());
        } else {
            bytes = new Uint8Array(await cachedResponse.arrayBuffer());
        }
        const digest = await sha256(bytes);
        if (digest !== policy.assetSha256[file]) {
            await cache.delete(url);
            throw new Error(`Built-in embedding asset failed integrity verification: ${file}`);
        }
        if (!cachedResponse) {
            await cache.put(url, new Response(bytes, {
                headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" },
            }));
        }
    }
    postMessage({ type: "progress", progress: 1, file: null });
    env.allowRemoteModels = false;
    const [tokenizerJson, tokenizerConfig] = await Promise.all([
        readCachedJson(cache, policy.files.tokenizer),
        readCachedJson(cache, policy.files.tokenizerConfig),
    ]);
    const tokenizer = new XLMRobertaTokenizer(tokenizerJson, tokenizerConfig);
    const model = await AutoModel.from_pretrained(policy.repository, {
        revision: policy.revision,
        dtype: policy.dtype,
        device: "wasm",
        local_files_only: true,
    });
    extractor = new FeatureExtractionPipeline({ task: "feature-extraction", model, tokenizer });
}

function configureRuntime(): void {
    // Transformers.js 把 Cache API 命中也归入 local_files_only 路径；关闭此项会在读缓存前直接报配置冲突。
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useFS = false;
    env.useFSCache = false;
    env.useBrowserCache = true;
    env.useCustomCache = false;
    // WASM 已随插件嵌入。关闭 Transformers.js 的 CDN 预加载，避免下载另一份运行时并覆盖固定版本。
    env.useWasmCache = false;
    env.cacheKey = cacheName;
    env.logLevel = LogLevel.WARNING;
    const wasmBackend = env.backends.onnx.wasm;
    if (!wasmBackend) throw new Error("ONNX Runtime WebAssembly backend is unavailable.");
    wasmBackend.numThreads = 1;
    wasmBackend.proxy = false;
    // Transformers.js 会预填 CDN wasmPaths；必须清除它，ONNX 才会使用 bundle 内置工厂。
    // 否则 Electron 环境中的外部工厂会误走 Node 分支并动态导入 worker_threads。
    wasmBackend.wasmPaths = undefined;
    wasmBackend.wasmBinary = decodeBase64(__VAULT_COACH_ORT_WASM_BASE64__);
}

function assetUrl(file: string): string {
    return `https://huggingface.co/${policy.repository}/resolve/${policy.revision}/${file}`;
}

async function readCachedJson(cache: Cache, file: string): Promise<Record<string, unknown>> {
    const response = await cache.match(assetUrl(file));
    if (!response) throw new Error(`Cached model asset is missing: ${file}`);
    return await response.json() as Record<string, unknown>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function validateVectors(vectors: number[][], expectedCount: number): void {
    if (vectors.length !== expectedCount) throw new Error("Built-in embedding returned the wrong vector count.");
    for (const vector of vectors) {
        if (vector.length !== policy.dimension || vector.some((value) => !Number.isFinite(value))) {
            throw new Error("Built-in embedding returned an invalid vector.");
        }
    }
}

function respond(id: string, result: unknown): void {
    postMessage({ type: "response", id, ok: true, result });
}

function serializeError(error: unknown): { name: string; message: string } {
    return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}

function parseRequest(value: unknown): { id: string; type: string; payload?: Record<string, unknown> } {
    if (typeof value !== "object" || value === null) throw new Error("Invalid local AI worker request.");
    const candidate = value as { id?: unknown; type?: unknown; payload?: unknown };
    if (typeof candidate.id !== "string" || typeof candidate.type !== "string") {
        throw new Error("Invalid local AI worker request.");
    }
    if (candidate.payload !== undefined && (typeof candidate.payload !== "object" || candidate.payload === null)) {
        throw new Error("Invalid local AI worker payload.");
    }
    return {
        id: candidate.id,
        type: candidate.type,
        payload: candidate.payload as Record<string, unknown> | undefined,
    };
}
