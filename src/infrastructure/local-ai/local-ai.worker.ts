import {
    AutoModel,
    AutoModelForSequenceClassification,
    AutoTokenizer,
    env,
    FeatureExtractionPipeline,
    LogLevel,
    XLMRobertaTokenizer,
} from "@huggingface/transformers";
import { BUILTIN_EMBEDDING_POLICY, BUILTIN_RERANK_POLICY } from "../../app/local-ai/model-registry";
import { BUILTIN_ORT_RUNTIME_POLICY } from "../../app/local-ai/runtime-registry";
import {
    LOCAL_AI_WORKER_PROTOCOL_VERSION,
    parseLocalAiWorkerRequest,
    type LocalAiWorkerRequest,
} from "./local-ai-worker-protocol";

const embeddingPolicy = BUILTIN_EMBEDDING_POLICY;
const rerankerPolicy = BUILTIN_RERANK_POLICY;
const embeddingCacheName = "vault-coach-local-ai-v1";
const rerankerCacheName = "vault-coach-local-ai-reranker-v1";
let extractor: FeatureExtractionPipeline | null = null;
let rerankerTokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let rerankerModel: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> | null = null;
let activeRole: "embedding" | "reranker" | null = null;
let queue = Promise.resolve();
const cancelledRequests = new Set<string>();

self.onmessage = (event: MessageEvent<unknown>) => {
    let request: LocalAiWorkerRequest;
    try { request = parseLocalAiWorkerRequest(event.data); } catch { return; }
    if (request.operation === "cancel") {
        if (request.role === "utility" || request.policyId !== policyIdForRole(request.role)) {
            respondError(request, new WorkerOperationError("policy-mismatch", false, "Local AI policy does not match this worker build."));
            return;
        }
        const targetRequestId = request.payload.targetRequestId;
        if (typeof targetRequestId === "string") cancelledRequests.add(targetRequestId);
        respond(request, { cancelled: typeof targetRequestId === "string" });
        return;
    }
    queue = queue.then(() => handleMessage(request)).catch(() => undefined);
};

async function handleMessage(message: LocalAiWorkerRequest): Promise<void> {
    try {
        if (message.role === "utility" || message.operation === "utility") {
            throw new WorkerOperationError("unsupported-operation", true, "This local AI operation is not supported.");
        }
        const expectedPolicyId = message.role === "embedding" ? embeddingPolicy.id : rerankerPolicy.id;
        if (message.policyId !== expectedPolicyId) throw new WorkerOperationError("policy-mismatch", false, "Local AI policy does not match this worker build.");
        if (cancelledRequests.delete(message.requestId)) return;
        if (message.operation === "prepare") {
            const runtime = parseRuntimeAssets(message.payload.runtime);
            if (message.role === "embedding") await prepareEmbedding(Boolean(message.payload.allowDownload), runtime, message);
            else await prepareReranker(Boolean(message.payload.allowDownload), runtime, message);
            respond(message, { ready: true });
            return;
        }
        if (message.operation === "embed") {
            if (message.role !== "embedding") throw new WorkerOperationError("unsupported-operation", true, "Embed requires the embedding role.");
            if (!extractor) throw new Error("Built-in embedding model is not ready. Run the prepare command first.");
            const texts = Array.isArray(message.payload.texts) ? message.payload.texts.map(String) : [];
            const purpose = String(message.payload.purpose) as keyof typeof embeddingPolicy.prefixes;
            const prefix = embeddingPolicy.prefixes[purpose];
            if (!prefix || texts.length === 0) throw new Error("Invalid built-in embedding request.");
            const startedAt = performance.now();
            const output = await extractor(texts.map((text) => `${prefix}${text}`), {
                pooling: embeddingPolicy.pooling,
                normalize: embeddingPolicy.normalize,
            });
            const vectors = output.tolist() as number[][];
            output.dispose?.();
            validateVectors(vectors, texts.length);
            if (cancelledRequests.delete(message.requestId)) return;
            const values = new Float32Array(texts.length * embeddingPolicy.dimension);
            vectors.forEach((vector, index) => values.set(vector, index * embeddingPolicy.dimension));
            const buffer = values.buffer;
            respond(message, {
                count: texts.length,
                dimension: embeddingPolicy.dimension,
                buffer,
                latencyMs: performance.now() - startedAt,
            }, [buffer]);
            return;
        }
        if (message.operation === "rerank") {
            if (message.role !== "reranker") throw new WorkerOperationError("unsupported-operation", true, "Rerank requires the reranker role.");
            const result = await rerank(message);
            respond(message, result);
            return;
        }
        if (message.operation === "clear") {
            await clearRole(message.role);
            respond(message, { cleared: true });
            return;
        }
        if (message.operation === "dispose") {
            await releaseActiveModel();
            respond(message, { disposed: true });
            close();
            return;
        }
        throw new WorkerOperationError("unsupported-operation", true, "This local AI operation is not supported.");
    } catch (error) {
        respondError(message, error);
    }
}

async function prepareEmbedding(allowDownload: boolean, runtime: WorkerRuntimeAssets, request: LocalAiWorkerRequest): Promise<void> {
    if (extractor && activeRole === "embedding") return;
    configureRuntime(runtime);
    const cache = await prepareModelAssets(embeddingPolicy, embeddingCacheName, allowDownload, request);
    env.cacheKey = embeddingCacheName;
    env.allowRemoteModels = false;
    const [tokenizerJson, tokenizerConfig] = await Promise.all([
        readCachedJson(cache, embeddingPolicy, embeddingPolicy.files.tokenizer),
        readCachedJson(cache, embeddingPolicy, embeddingPolicy.files.tokenizerConfig),
    ]);
    const tokenizer = new XLMRobertaTokenizer(tokenizerJson, tokenizerConfig);
    await releaseActiveModel();
    const model = await AutoModel.from_pretrained(embeddingPolicy.repository, {
        revision: embeddingPolicy.revision,
        dtype: embeddingPolicy.dtype,
        device: "wasm",
        local_files_only: true,
    });
    extractor = new FeatureExtractionPipeline({ task: "feature-extraction", model, tokenizer });
    activeRole = "embedding";
}

async function prepareReranker(allowDownload: boolean, runtime: WorkerRuntimeAssets, request: LocalAiWorkerRequest): Promise<void> {
    if (rerankerModel && rerankerTokenizer && activeRole === "reranker") return;
    configureRuntime(runtime);
    await prepareModelAssets(rerankerPolicy, rerankerCacheName, allowDownload, request);
    env.cacheKey = rerankerCacheName;
    env.allowRemoteModels = false;
    const options = {
        revision: rerankerPolicy.revision,
        dtype: rerankerPolicy.dtype,
        device: "wasm" as const,
        local_files_only: true,
    };
    const tokenizer = await AutoTokenizer.from_pretrained(rerankerPolicy.repository, options);
    await releaseActiveModel();
    const model = await AutoModelForSequenceClassification.from_pretrained(rerankerPolicy.repository, options);
    rerankerTokenizer = tokenizer;
    rerankerModel = model;
    activeRole = "reranker";
}

async function prepareModelAssets(
    modelPolicy: typeof embeddingPolicy | typeof rerankerPolicy,
    modelCacheName: string,
    allowDownload: boolean,
    request: LocalAiWorkerRequest,
): Promise<Cache> {
    const requiredFiles = Object.values(modelPolicy.files);
    const cache = await caches.open(modelCacheName);
    for (let index = 0; index < requiredFiles.length; index += 1) {
        const file = requiredFiles[index]!;
        const url = assetUrl(modelPolicy, file);
        const cachedResponse = await cache.match(url);
        let bytes: Uint8Array;
        if (!cachedResponse) {
            if (!allowDownload) throw new Error(`Built-in ${modelPolicy.role} assets are not installed. Run the prepare action while online.`);
            progress(request, index / requiredFiles.length);
            // Dedicated Worker 无法导入 Obsidian requestUrl；这里只下载用户明确同意的固定版本资产。
            const response = await globalThis.fetch(url, { cache: "no-store" });
            if (!response.ok) throw new Error(`Model asset download failed (${response.status}): ${file}`);
            bytes = new Uint8Array(await response.arrayBuffer());
        } else {
            bytes = new Uint8Array(await cachedResponse.arrayBuffer());
        }
        const digest = await sha256(bytes);
        if (digest !== modelPolicy.assetSha256[file as keyof typeof modelPolicy.assetSha256]) {
            await cache.delete(url);
            throw new Error(`Built-in ${modelPolicy.role} asset failed integrity verification: ${file}`);
        }
        if (!cachedResponse) {
            await cache.put(url, new Response(bytes, {
                headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" },
            }));
        }
    }
    progress(request, 1);
    return cache;
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

function assetUrl(modelPolicy: typeof embeddingPolicy | typeof rerankerPolicy, file: string): string {
    return `https://huggingface.co/${modelPolicy.repository}/resolve/${modelPolicy.revision}/${file}`;
}

function policyIdForRole(role: "embedding" | "reranker"): string {
    return role === "embedding" ? embeddingPolicy.id : rerankerPolicy.id;
}

async function readCachedJson(
    cache: Cache,
    modelPolicy: typeof embeddingPolicy | typeof rerankerPolicy,
    file: string,
): Promise<Record<string, unknown>> {
    const response = await cache.match(assetUrl(modelPolicy, file));
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
        if (vector.length !== embeddingPolicy.dimension || vector.some((value) => !Number.isFinite(value))) {
            throw new Error("Built-in embedding returned an invalid vector.");
        }
    }
}

async function rerank(request: LocalAiWorkerRequest): Promise<{
    scores: Array<{ candidateId: string; score: number }>;
    latencyMs: number;
    truncatedCandidateCount: number;
}> {
    if (!rerankerTokenizer || !rerankerModel || activeRole !== "reranker") {
        throw new Error("Built-in reranker is not ready. Run the prepare action first.");
    }
    const query = typeof request.payload.query === "string" ? request.payload.query : "";
    const rawCandidates = Array.isArray(request.payload.candidates) ? request.payload.candidates : [];
    const candidates = rawCandidates.map((value) => {
        if (typeof value !== "object" || value === null) throw new Error("Invalid built-in rerank candidate.");
        const candidate = value as { id?: unknown; text?: unknown };
        if (typeof candidate.id !== "string" || candidate.id.length === 0 || typeof candidate.text !== "string") {
            throw new Error("Invalid built-in rerank candidate.");
        }
        return { id: candidate.id, text: candidate.text };
    });
    if (!query || candidates.length === 0) throw new Error("Invalid built-in rerank request.");
    const seenIds = new Set<string>();
    for (const candidate of candidates) {
        if (seenIds.has(candidate.id)) throw new Error(`Duplicate built-in rerank candidate ID: ${candidate.id}`);
        seenIds.add(candidate.id);
    }
    const startedAt = performance.now();
    const preparedPairs = candidates.map((candidate) => prepareRerankPair(query, candidate.text));
    const scores: Array<{ candidateId: string; score: number }> = [];
    const truncatedCandidateCount = preparedPairs.filter((pair) => pair.truncated).length;
    for (let offset = 0; offset < candidates.length; offset += rerankerPolicy.batchSize) {
        if (cancelledRequests.has(request.requestId)) throw new DOMException("Rerank request aborted.", "AbortError");
        const batchCandidates = candidates.slice(offset, offset + rerankerPolicy.batchSize);
        const batchPairs = preparedPairs.slice(offset, offset + rerankerPolicy.batchSize);
        const inputs = rerankerTokenizer(batchPairs.map((pair) => pair.query), {
            text_pair: batchPairs.map((pair) => pair.document),
            padding: true,
            truncation: true,
            max_length: rerankerPolicy.maxTokens,
        });
        const runModel = rerankerModel as unknown as RerankerModelRunner;
        const output = await runModel(inputs);
        const logits = decodeSingleLogits(output.logits.tolist());
        output.logits.dispose?.();
        if (logits.length !== batchCandidates.length) throw new Error("Built-in reranker returned the wrong score count.");
        logits.forEach((score, index) => {
            const candidate = batchCandidates[index];
            if (!candidate || typeof score !== "number" || !Number.isFinite(score)) {
                throw new Error("Built-in reranker returned an invalid single logit.");
            }
            scores.push({ candidateId: candidate.id, score });
        });
    }
    if (cancelledRequests.delete(request.requestId)) throw new DOMException("Rerank request aborted.", "AbortError");
    return { scores, latencyMs: performance.now() - startedAt, truncatedCandidateCount };
}

function prepareRerankPair(query: string, document: string): { query: string; document: string; truncated: boolean } {
    if (!rerankerTokenizer) throw new Error("Built-in reranker tokenizer is unavailable.");
    const queryEncoding = rerankerTokenizer(query, { add_special_tokens: false, return_tensor: false });
    const documentEncoding = rerankerTokenizer(document, { add_special_tokens: false, return_tensor: false });
    const rawQueryIds = queryEncoding.input_ids;
    const rawDocumentIds = documentEncoding.input_ids;
    const queryIds = rawQueryIds.slice(0, rerankerPolicy.maxQueryTokens);
    const documentBudget = Math.max(1, rerankerPolicy.maxTokens - queryIds.length - 4);
    const documentIds = rawDocumentIds.slice(0, documentBudget);
    return {
        query: rerankerTokenizer.decode(queryIds, { skip_special_tokens: true }),
        document: rerankerTokenizer.decode(documentIds, { skip_special_tokens: true }),
        truncated: queryIds.length < rawQueryIds.length || documentIds.length < rawDocumentIds.length,
    };
}

function decodeSingleLogits(value: unknown): number[] {
    if (!Array.isArray(value)) throw new Error("Built-in reranker returned invalid logits.");
    return value.map((row) => {
        if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== "number" || !Number.isFinite(row[0])) {
            throw new Error("Built-in reranker returned an invalid single logit.");
        }
        return row[0];
    });
}

async function clearRole(role: "embedding" | "reranker"): Promise<void> {
    if (role === "embedding") {
        if (activeRole === "embedding") await releaseActiveModel();
        await caches.delete(embeddingCacheName);
        return;
    }
    if (activeRole === "reranker") await releaseActiveModel();
    await caches.delete(rerankerCacheName);
}

async function releaseActiveModel(): Promise<void> {
    await extractor?.dispose?.();
    await rerankerModel?.dispose?.();
    extractor = null;
    rerankerTokenizer = null;
    rerankerModel = null;
    activeRole = null;
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

interface RerankerModelOutput {
    logits: {
        tolist(): unknown;
        dispose?(): void;
    };
}

type RerankerModelRunner = (inputs: unknown) => Promise<RerankerModelOutput>;

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
