import path from "node:path";
import { parseArguments } from "./spikes/local-ai/lib/cli.mjs";
import { loadCandidate, loadProtocol, loadRetrievalDataset, REPOSITORY_ROOT } from "./spikes/local-ai/lib/config.mjs";
import { evaluateRankings, evaluateThresholds, rankByCosine, rankByKeyword, summarizeNumbers } from "./spikes/local-ai/lib/metrics.mjs";
import { createRunId, environmentSnapshot, writeResult } from "./spikes/local-ai/lib/result-writer.mjs";
import { createTransformersRuntime, embedTexts, loadFeatureExtractor } from "./spikes/local-ai/lib/transformers-runtime.mjs";

const args = parseArguments(process.argv.slice(2), {
    candidate: { type: "string", defaultValue: "multilingual-e5-small-uint8" },
    device: { type: "string", defaultValue: "cpu" },
    split: { type: "string", defaultValue: "acceptance" },
    "batch-size": { type: "number", defaultValue: 8 },
    "allow-download": { type: "boolean", defaultValue: false },
});
if (!["cpu", "webgpu"].includes(args.device)) throw new Error("Node CLI 的 --device 只接受 cpu 或 webgpu。");
if (!["tuning", "acceptance"].includes(args.split)) throw new Error("--split 只接受 tuning 或 acceptance。");
if (!Number.isInteger(args["batch-size"]) || args["batch-size"] <= 0) throw new Error("--batch-size 必须是正整数。");

const [protocol, candidate] = await Promise.all([loadProtocol(), loadCandidate(args.candidate)]);
const dataset = await loadRetrievalDataset(protocol);
const queries = dataset.queries.filter((query) => query.split === args.split);
const runId = createRunId("retrieval-benchmark");
let runtime;
let extractor;
try {
    runtime = await createTransformersRuntime({
        device: args.device,
        allowDownload: args["allow-download"],
        cacheDirectory: path.join(REPOSITORY_ROOT, ".m4-model-cache"),
    });
    const loadStartedAt = performance.now();
    extractor = await loadFeatureExtractor(runtime, candidate, args.device, args["allow-download"], reportProgress);
    const loadMs = performance.now() - loadStartedAt;
    const corpusStartedAt = performance.now();
    const corpusRecords = [];
    for (let offset = 0; offset < dataset.corpus.length; offset += args["batch-size"]) {
        const batch = dataset.corpus.slice(offset, offset + args["batch-size"]);
        const vectors = await embedTexts(extractor, candidate, "document", batch.map((chunk) => chunk.text));
        batch.forEach((chunk, index) => corpusRecords.push({ chunkId: chunk.id, vector: vectors[index] }));
    }
    const corpusDurationMs = performance.now() - corpusStartedAt;
    const rankings = new Map();
    const queryLatencies = [];
    for (const query of queries) {
        let queryVector;
        for (let run = 0; run < protocol.measurement.warmupRuns + protocol.measurement.measuredRuns; run += 1) {
            const startedAt = performance.now();
            [queryVector] = await embedTexts(extractor, candidate, "query", [query.text]);
            const duration = performance.now() - startedAt;
            if (run >= protocol.measurement.warmupRuns) queryLatencies.push(duration);
        }
        rankings.set(query.id, rankByCosine(queryVector, corpusRecords));
    }
    const metricsByLanguage = {};
    for (const language of Object.keys(protocol.dataset.queries)) {
        metricsByLanguage[language] = evaluateRankings(
            queries.filter((query) => query.language === language),
            rankings,
            protocol.measurement.topK,
        );
    }
    const performanceMetrics = {
        loadMs,
        corpusDurationMs,
        corpusChunksPerSecond: dataset.corpus.length / (corpusDurationMs / 1000),
        queryLatencyMs: summarizeNumbers(queryLatencies),
        rssMb: process.memoryUsage().rss / 1024 / 1024,
    };
    const keywordRankings = new Map(queries.map((query) => [query.id, rankByKeyword(query.text, dataset.corpus)]));
    const keywordMetricsByLanguage = {};
    for (const language of Object.keys(protocol.dataset.queries)) {
        keywordMetricsByLanguage[language] = evaluateRankings(
            queries.filter((query) => query.language === language),
            keywordRankings,
            protocol.measurement.topK,
        );
    }
    const decision = evaluateThresholds(metricsByLanguage, protocol, performanceMetrics);
    const result = {
        schemaVersion: 1,
        runId,
        status: decision.status,
        environment: environmentSnapshot(args.device),
        candidate: { id: candidate.id, repository: candidate.repository, revision: candidate.revision, dtype: candidate.dtype },
        protocol: { id: protocol.protocolId, status: protocol.status, split: args.split },
        configuration: { batchSize: args["batch-size"], allowDownload: args["allow-download"] },
        scope: "node-cli-reference-only",
        doesNotAuthorizeMilestoneGo: true,
        performance: performanceMetrics,
        quality: metricsByLanguage,
        keywordBaseline: keywordMetricsByLanguage,
        decision,
        rankings: Object.fromEntries([...rankings].map(([queryId, ranking]) => [queryId, ranking.slice(0, 10)])),
        requests: runtime?.requests ?? [],
    };
    const relativePath = await writeResult(runId, "benchmark.json", result);
    console.log(`[M4] Benchmark 完成，状态 ${result.status}，结果：${relativePath}`);
} catch (error) {
    const relativePath = await writeResult(runId, "benchmark.json", {
        schemaVersion: 1,
        runId,
        status: "fail",
        environment: environmentSnapshot(args.device),
        candidate: { id: candidate.id, repository: candidate.repository, revision: candidate.revision, dtype: candidate.dtype },
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) },
        requests: runtime?.requests ?? [],
    });
    console.error(`[M4] Benchmark 失败，结果：${relativePath}`);
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
