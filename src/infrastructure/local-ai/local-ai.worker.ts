import {
    AutoModel,
    env,
    FeatureExtractionPipeline,
    LogLevel,
    XLMRobertaTokenizer,
} from "@huggingface/transformers";
import { BUILTIN_EMBEDDING_POLICY } from "../../app/local-ai/model-registry";
import { BUILTIN_ORT_RUNTIME_POLICY } from "../../app/local-ai/runtime-registry";
import {
    LOCAL_AI_WORKER_PROTOCOL_VERSION,
    parseLocalAiWorkerRequest,
    type LocalAiWorkerRequest,
} from "./local-ai-worker-protocol";

const policy = BUILTIN_EMBEDDING_POLICY;
const requiredFiles = Object.values(policy.files);

const cacheName = "vault-coach-local-ai-v1";
let extractor: FeatureExtractionPipeline | null = null;
let queue = Promise.resolve();
const cancelledRequests = new Set<string>();

self.onmessage = (event: MessageEvent<unknown>) => {
    let request: LocalAiWorkerRequest;
    try { request = parseLocalAiWorkerRequest(event.data); } catch { return; }
    queue = queue.then(() => handleMessage(request)).catch(() => undefined);
};

async function handleMessage(message: LocalAiWorkerRequest): Promise<void> {
    try {
        if (message.role !== "embedding" || message.operation === "rerank" || message.operation === "utility") {
            throw new WorkerOperationError("unsupported-operation", true, "This local AI operation is not supported.");
        }
        if (message.policyId !== policy.id) throw new WorkerOperationError("policy-mismatch", false, "Local AI policy does not match this worker build.");
        if (message.operation === "cancel") {
            const targetRequestId = message.payload.targetRequestId;
            if (typeof targetRequestId === "string") cancelledRequests.add(targetRequestId);
            respond(message, { cancelled: typeof targetRequestId === "string" });
            return;
        }
        if (cancelledRequests.delete(message.requestId)) return;
        if (message.operation === "prepare") {
            await prepare(Boolean(message.payload.allowDownload), parseRuntimeAssets(message.payload.runtime), message);
            respond(message, { ready: true });
            return;
        }
        if (message.operation === "embed") {
            if (!extractor) throw new Error("Built-in embedding model is not ready. Run the prepare command first.");
            const texts = Array.isArray(message.payload.texts) ? message.payload.texts.map(String) : [];
            const purpose = String(message.payload.purpose) as keyof typeof policy.prefixes;
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
            if (cancelledRequests.delete(message.requestId)) return;
            const values = new Float32Array(texts.length * policy.dimension);
            vectors.forEach((vector, index) => values.set(vector, index * policy.dimension));
            const buffer = values.buffer;
            respond(message, {
                count: texts.length,
                dimension: policy.dimension,
                buffer,
                latencyMs: performance.now() - startedAt,
            }, [buffer]);
            return;
        }
        if (message.operation === "clear") {
            await extractor?.dispose?.();
            extractor = null;
            await caches.delete(cacheName);
            respond(message, { cleared: true });
            return;
        }
        if (message.operation === "dispose") {
            await extractor?.dispose?.();
            extractor = null;
            respond(message, { disposed: true });
            close();
            return;
        }
        throw new WorkerOperationError("unsupported-operation", true, "This local AI operation is not supported.");
    } catch (error) {
        respondError(message, error);
    }
}

async function prepare(allowDownload: boolean, runtime: WorkerRuntimeAssets, request: LocalAiWorkerRequest): Promise<void> {
    if (extractor) return;
    configureRuntime(runtime);
    const cache = await caches.open(cacheName);
    for (let index = 0; index < requiredFiles.length; index += 1) {
        const file = requiredFiles[index]!;
        const url = assetUrl(file);
        const cachedResponse = await cache.match(url);
        let bytes: Uint8Array;
        if (!cachedResponse) {
            if (!allowDownload) throw new Error("Built-in embedding assets are not installed. Run the prepare command while online.");
            progress(request, index / requiredFiles.length);
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
    progress(request, 1);
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

function configureRuntime(runtime: WorkerRuntimeAssets): void {
    // Transformers.js 把 Cache API 命中也归入 local_files_only 路径；关闭此项会在读缓存前直接报配置冲突。
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useFS = false;
    env.useFSCache = false;
    env.useBrowserCache = true;
    env.useCustomCache = false;
    // Runtime 由主线程按当前插件固定的版本和 SHA-256 下载、验证并从本机缓存恢复。
    // 关闭 Transformers.js 自带下载，确保只有受控的 wasmBinary 能进入执行路径。
    env.useWasmCache = false;
    env.cacheKey = cacheName;
    env.logLevel = LogLevel.WARNING;
    const wasmBackend = env.backends.onnx.wasm;
    if (!wasmBackend) throw new Error("ONNX Runtime WebAssembly backend is unavailable.");
    wasmBackend.numThreads = 1;
    wasmBackend.proxy = false;
    // 单线程 + wasmBinary 会复用 Worker bundle 内的固定 JS factory，不加载远程 .mjs。
    // 清除默认 CDN 路径还能避免 Electron 环境再次误走 worker_threads 分支。
    wasmBackend.wasmPaths = undefined;
    wasmBackend.wasmBinary = runtime.wasmBinary;
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

function validateVectors(vectors: number[][], expectedCount: number): void {
    if (vectors.length !== expectedCount) throw new Error("Built-in embedding returned the wrong vector count.");
    for (const vector of vectors) {
        if (vector.length !== policy.dimension || vector.some((value) => !Number.isFinite(value))) {
            throw new Error("Built-in embedding returned an invalid vector.");
        }
    }
}

function respond(request: LocalAiWorkerRequest, result: unknown, transfer: Transferable[] = []): void {
    postWorkerMessage({
        v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
        type: "response",
        requestId: request.requestId,
        jobId: request.jobId,
        workerEpoch: request.workerEpoch,
        role: request.role,
        policyId: request.policyId,
        ok: true,
        result,
    }, transfer);
}

function respondError(request: LocalAiWorkerRequest, error: unknown): void {
    const operationError = error instanceof WorkerOperationError ? error : null;
    postWorkerMessage({
        v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
        type: "response",
        requestId: request.requestId,
        jobId: request.jobId,
        workerEpoch: request.workerEpoch,
        role: request.role,
        policyId: request.policyId,
        ok: false,
        error: {
            code: operationError?.code ?? "operation-failed",
            recoverable: operationError?.recoverable ?? true,
            safeMessage: error instanceof Error ? error.message : "Local AI worker operation failed.",
        },
    });
}

function progress(request: LocalAiWorkerRequest, value: number): void {
    postWorkerMessage({
        v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
        type: "progress",
        requestId: request.requestId,
        jobId: request.jobId,
        workerEpoch: request.workerEpoch,
        role: request.role,
        policyId: request.policyId,
        progress: Math.max(0, Math.min(1, value)),
    });
}

class WorkerOperationError extends Error {
    constructor(readonly code: string, readonly recoverable: boolean, message: string) { super(message); }
}

function postWorkerMessage(message: unknown, transfer: Transferable[] = []): void {
    (self as unknown as { postMessage(value: unknown, transfer?: Transferable[]): void }).postMessage(message, transfer);
}

interface WorkerRuntimeAssets {
    policyId: string;
    wasmBinary: ArrayBuffer;
}

function parseRuntimeAssets(value: unknown): WorkerRuntimeAssets {
    if (typeof value !== "object" || value === null) throw new Error("Built-in embedding runtime payload is missing.");
    const candidate = value as { policyId?: unknown; wasmBinary?: unknown };
    if (candidate.policyId !== BUILTIN_ORT_RUNTIME_POLICY.id) {
        throw new Error("Built-in embedding runtime policy does not match this plugin build.");
    }
    if (!(candidate.wasmBinary instanceof ArrayBuffer)
        || candidate.wasmBinary.byteLength !== BUILTIN_ORT_RUNTIME_POLICY.artifact.bytes) {
        throw new Error("Built-in embedding runtime binary is invalid.");
    }
    return { policyId: candidate.policyId, wasmBinary: candidate.wasmBinary };
}
