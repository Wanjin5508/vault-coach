import { access } from "node:fs/promises";
import path from "node:path";
import { parseArguments } from "./lib/cli.mjs";
import { loadCandidate, REPOSITORY_ROOT } from "./lib/config.mjs";
import { createRunId, environmentSnapshot, writeResult } from "./lib/result-writer.mjs";
import { createTransformersRuntime, embedTexts, loadFeatureExtractor } from "./lib/transformers-runtime.mjs";

const args = parseArguments(process.argv.slice(2), {
    candidate: { type: "string", defaultValue: "multilingual-e5-small-uint8" },
    device: { type: "string", defaultValue: "cpu" },
    "allow-download": { type: "boolean", defaultValue: false },
});
if (!["cpu", "webgpu"].includes(args.device)) throw new Error("Node CLI 的 --device 只接受 cpu 或 webgpu。");

const candidate = await loadCandidate(args.candidate);
if (!candidate.allowedDevices.includes(args.device)) throw new Error(`${candidate.id} 不允许在 ${args.device} 上运行。`);
const runId = createRunId("embedding-smoke");
const cacheDirectory = path.join(REPOSITORY_ROOT, ".m4-model-cache");
let runtime;
let extractor;
try {
    runtime = await createTransformersRuntime({
        device: args.device,
        allowDownload: args["allow-download"],
        cacheDirectory,
    });
    const requiredFiles = candidateCacheFiles(candidate);
    const cachedBefore = await areCandidateFilesCached(cacheDirectory, candidate, requiredFiles);
    const startedAt = performance.now();
    extractor = await loadFeatureExtractor(runtime, candidate, args.device, args["allow-download"], reportProgress);
    const loadMs = performance.now() - startedAt;
    const inferenceStartedAt = performance.now();
    const [queryVector] = await embedTexts(extractor, candidate, "query", ["如何在离线状态下验证模型缓存？"]);
    const [documentVector] = await embedTexts(extractor, candidate, "document", ["断开网络后重新加载模型并生成向量，可以验证暖缓存是否完整。"]);
    const [graphVector] = await embedTexts(extractor, candidate, "graph", ["Offline model cache verification"]);
    const inferenceMs = performance.now() - inferenceStartedAt;
    const result = {
        schemaVersion: 1,
        runId,
        status: "pass",
        environment: environmentSnapshot(args.device),
        candidate: snapshotCandidate(candidate),
        mode: args["allow-download"] ? "download-allowed" : "offline-only",
        metrics: {
            loadMs,
            inferenceMs,
            dimension: queryVector.length,
            queryNorm: vectorNorm(queryVector),
            documentNorm: vectorNorm(documentVector),
            graphNorm: vectorNorm(graphVector),
            rssMb: process.memoryUsage().rss / 1024 / 1024,
        },
        assets: {
            requiredFiles,
            cachedBefore,
            cachedAfter: await areCandidateFilesCached(cacheDirectory, candidate, requiredFiles),
        },
        requests: runtime?.requests ?? [],
    };
    const relativePath = await writeResult(runId, "smoke.json", result);
    console.log(`[M4] Embedding smoke 通过，结果：${relativePath}`);
} catch (error) {
    const relativePath = await writeResult(runId, "smoke.json", {
        schemaVersion: 1,
        runId,
        status: "fail",
        environment: environmentSnapshot(args.device),
        candidate: snapshotCandidate(candidate),
        mode: args["allow-download"] ? "download-allowed" : "offline-only",
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) },
        requests: runtime?.requests ?? [],
    });
    console.error(`[M4] Embedding smoke 失败，结果：${relativePath}`);
    throw error;
} finally {
    await extractor?.dispose?.();
    await runtime?.close();
}

function reportProgress(event) {
    if (event.status === "progress_total" && Number.isFinite(event.progress)) {
        process.stdout.write(`\r[M4] 模型准备 ${Math.round(event.progress)}%`);
        if (event.progress >= 100) process.stdout.write("\n");
    }
}

function vectorNorm(vector) {
    return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function snapshotCandidate(value) {
    return { id: value.id, repository: value.repository, revision: value.revision, dtype: value.dtype };
}

function candidateCacheFiles(candidateValue) {
    return ["config.json", candidateValue.modelFile, "tokenizer.json", "tokenizer_config.json"];
}

async function areCandidateFilesCached(cacheRoot, candidateValue, requiredFiles) {
    const revisionRoot = path.join(cacheRoot, candidateValue.repository, candidateValue.revision);
    const checks = await Promise.all(requiredFiles.map(async (relativePath) => {
        try {
            await access(path.join(revisionRoot, relativePath));
            return true;
        } catch {
            return false;
        }
    }));
    return checks.every(Boolean);
}
