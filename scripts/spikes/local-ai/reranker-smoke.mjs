import path from "node:path";
import { parseArguments } from "./lib/cli.mjs";
import { loadCandidate, REPOSITORY_ROOT } from "./lib/config.mjs";
import { createRunId, environmentSnapshot, writeResult } from "./lib/result-writer.mjs";
import {
    createTransformersRuntime,
    loadSequenceClassifier,
    scoreTextPairs,
} from "./lib/transformers-runtime.mjs";

const args = parseArguments(process.argv.slice(2), {
    candidate: { type: "string", defaultValue: "mmarco-minilm-l12-q8-reranker" },
    device: { type: "string", defaultValue: "cpu" },
    "allow-download": { type: "boolean", defaultValue: false },
    "model-path": { type: "string", defaultValue: "" },
});
if (!["cpu", "webgpu"].includes(args.device)) throw new Error("Node CLI 的 --device 只接受 cpu 或 webgpu。");

const candidate = await loadCandidate(args.candidate);
if (candidate.role !== "reranker") throw new Error(`${candidate.id} 不是 reranker 候选。`);
if (!candidate.allowedDevices.includes(args.device)) throw new Error(`${candidate.id} 不允许在 ${args.device} 上运行。`);
const runId = createRunId("reranker-smoke");
const cacheDirectory = path.join(REPOSITORY_ROOT, ".m4-model-cache");
let runtime;
let model;
try {
    runtime = await createTransformersRuntime({
        device: args.device,
        allowDownload: args["allow-download"] && !args["model-path"],
        cacheDirectory,
    });
    const loadStartedAt = performance.now();
    const loaded = await loadSequenceClassifier(
        runtime,
        candidate,
        args.device,
        args["allow-download"],
        reportProgress,
        args["model-path"],
    );
    model = loaded.model;
    const loadMs = performance.now() - loadStartedAt;
    const query = "如何验证本地模型在断网后仍然可用？";
    const documents = [
        "先在线下载并校验模型资产，然后断开网络，从缓存重新加载并运行推理。",
        "光合作用把光能转化为化学能。",
        "Git 分支用于隔离不同功能的代码改动。",
    ];
    const inferenceStartedAt = performance.now();
    const scores = await scoreTextPairs(loaded.tokenizer, model, candidate, query, documents);
    const inferenceMs = performance.now() - inferenceStartedAt;
    const ranking = scores.map((score, index) => ({ index, score })).sort((left, right) => right.score - left.score);
    if (ranking[0]?.index !== 0) throw new Error("最小可判别样本未把相关文档排在第一位。");
    const relativePath = await writeResult(runId, "smoke.json", {
        schemaVersion: 1,
        runId,
        status: "pass",
        environment: environmentSnapshot(args.device),
        candidate: snapshotCandidate(candidate),
        mode: args["model-path"] ? "local-path" : args["allow-download"] ? "download-allowed" : "offline-only",
        metrics: { loadMs, inferenceMs, rssMb: process.memoryUsage().rss / 1024 / 1024 },
        output: { shape: [scores.length, 1], scoreTransform: candidate.scoreTransform, scores, ranking },
        requests: runtime.requests,
    });
    console.log(`[M6.1] Reranker smoke 通过，结果：${relativePath}`);
} catch (error) {
    const relativePath = await writeResult(runId, "smoke.json", {
        schemaVersion: 1,
        runId,
        status: "fail",
        environment: environmentSnapshot(args.device),
        candidate: snapshotCandidate(candidate),
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) },
        requests: runtime?.requests ?? [],
    });
    console.error(`[M6.1] Reranker smoke 失败，结果：${relativePath}`);
    throw error;
} finally {
    await model?.dispose?.();
    await runtime?.close();
}

function reportProgress(event) {
    if (event.status === "progress_total" && Number.isFinite(event.progress)) {
        process.stdout.write(`\r[M6.1] 模型准备 ${Math.round(event.progress)}%`);
        if (event.progress >= 100) process.stdout.write("\n");
    }
}

function snapshotCandidate(value) {
    return {
        id: value.id,
        repository: value.repository,
        revision: value.revision,
        dtype: value.dtype,
        maxTokens: value.maxTokens,
        scoreTransform: value.scoreTransform,
    };
}
