import { readJson, loadModelLedger, loadProtocol, loadRetrievalDataset } from "./lib/config.mjs";
import { evaluateRankings, rankByCosine } from "./lib/metrics.mjs";

const errors = [];
const warnings = [];
const protocol = await loadProtocol();
const ledger = await loadModelLedger();
const packageJson = await readJson("package.json");
const { corpus, queries } = await loadRetrievalDataset(protocol);

check(protocol.schemaVersion === 1, "protocol schemaVersion 必须为 1。");
check(protocol.runtime.version === packageJson.devDependencies?.["@huggingface/transformers"],
    "protocol 与 package.json 的 Transformers.js 版本不一致。");
if (protocol.status !== "approved") warnings.push("实验协议尚未批准；任何结果只能是 pending，不能产生 GO。");

const candidateIds = new Set();
for (const candidate of ledger.candidates) {
    check(!candidateIds.has(candidate.id), `模型候选 ID 重复：${candidate.id}`);
    candidateIds.add(candidate.id);
    check(typeof candidate.repository === "string" && candidate.repository.includes("/"), `${candidate.id} 缺少 repository。`);
    if (!/^[a-f0-9]{40}$/u.test(candidate.revision)) {
        const message = `${candidate.id} 未锁定 40 位 commit revision。`;
        if (candidate.status === "candidate") errors.push(message); else warnings.push(message);
    }
    if (candidate.license?.status?.startsWith("pending")) warnings.push(`${candidate.id} 的许可证仍需人工核对。`);
    if (candidate.assetSha256) {
        for (const [assetPath, sha256] of Object.entries(candidate.assetSha256)) {
            check(/^[a-f0-9]{64}$/u.test(sha256), `${candidate.id} 的 ${assetPath} SHA-256 无效。`);
        }
    }
    if (candidate.assetBytes) {
        check(candidate.assetSha256 !== undefined, `${candidate.id} 有 assetBytes 但没有 assetSha256。`);
        check(sameKeys(candidate.assetBytes, candidate.assetSha256 ?? {}), `${candidate.id} 的 assetBytes 与 assetSha256 文件集合不一致。`);
        for (const [assetPath, bytes] of Object.entries(candidate.assetBytes)) {
            check(Number.isSafeInteger(bytes) && bytes > 0, `${candidate.id} 的 ${assetPath} 字节数无效。`);
        }
    }
    if (candidate.modelFile && candidate.assetSha256) {
        check(candidate.assetSha256?.[candidate.modelFile] === candidate.modelFileSha256,
            `${candidate.id} 的模型文件哈希与资产清单不一致。`);
        check(candidate.assetBytes === undefined || candidate.assetBytes[candidate.modelFile] === candidate.modelFileBytes,
            `${candidate.id} 的模型文件字节数与资产清单不一致。`);
    }
    if (candidate.role === "utility") validateUtilityCandidate(candidate);
}

const chunkIds = new Set();
for (const chunk of corpus) {
    check(typeof chunk.id === "string" && chunk.id.length > 0, "corpus 存在空 chunk ID。");
    check(!chunkIds.has(chunk.id), `corpus chunk ID 重复：${chunk.id}`);
    chunkIds.add(chunk.id);
    check(typeof chunk.text === "string" && chunk.text.length >= 20, `${chunk.id} 文本过短。`);
}

const queryIds = new Set();
for (const query of queries) {
    check(!queryIds.has(query.id), `query ID 重复：${query.id}`);
    queryIds.add(query.id);
    check(["tuning", "acceptance"].includes(query.split), `${query.id} 的 split 无效。`);
    check(Array.isArray(query.relevantChunkIds), `${query.id} 缺少 relevantChunkIds。`);
    for (const chunkId of query.relevantChunkIds ?? []) check(chunkIds.has(chunkId), `${query.id} 引用了不存在的 ${chunkId}。`);
    if (query.relevantChunkIds?.length === 0) check(query.tags?.includes("no-answer"), `${query.id} 无答案但缺少 no-answer 标签。`);
}

for (const language of Object.keys(protocol.dataset.queries)) {
    const languageQueries = queries.filter((query) => query.language === language);
    check(languageQueries.length >= protocol.dataset.minimumQueriesPerLanguage,
        `${language} 只有 ${languageQueries.length} 个 query，少于 ${protocol.dataset.minimumQueriesPerLanguage}。`);
    check(languageQueries.some((query) => query.split === protocol.dataset.lockedSplit), `${language} 缺少锁定验收集。`);
}

runMetricSelfCheck();

for (const warning of warnings) console.warn(`[M4 warning] ${warning}`);
if (errors.length > 0) {
    for (const error of errors) console.error(`[M4 error] ${error}`);
    process.exitCode = 1;
} else {
    console.log(`[M4] 资产校验通过：${corpus.length} chunks，${queries.length} queries，${ledger.candidates.length} candidates。`);
}

function check(condition, message) {
    if (!condition) errors.push(message);
}

function sameKeys(left, right) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

function validateUtilityCandidate(candidate) {
    check(candidate.task === "text-generation", `${candidate.id} 的 utility task 必须为 text-generation。`);
    check(candidate.assetSha256 !== undefined && candidate.assetBytes !== undefined,
        `${candidate.id} 缺少完整的 utility 资产哈希或字节清单。`);
    check(/^[a-f0-9]{64}$/u.test(candidate.chatTemplateSha256 ?? ""), `${candidate.id} 缺少有效 chat template SHA-256。`);
    check(Number.isSafeInteger(candidate.utilityTaskPolicyVersion) && candidate.utilityTaskPolicyVersion > 0,
        `${candidate.id} 缺少有效 utilityTaskPolicyVersion。`);
    for (const task of ["query-rewrite", "memory-extraction"]) {
        const budget = candidate.tasks?.[task];
        check(Number.isSafeInteger(budget?.maxPromptTokens) && budget.maxPromptTokens > 0,
            `${candidate.id} 的 ${task} maxPromptTokens 无效。`);
        check(Number.isSafeInteger(budget?.maxNewTokens) && budget.maxNewTokens > 0,
            `${candidate.id} 的 ${task} maxNewTokens 无效。`);
    }
}

function runMetricSelfCheck() {
    const corpusRecords = [
        { chunkId: "a", vector: [1, 0] },
        { chunkId: "b", vector: [0, 1] },
    ];
    const rankings = new Map([["q", rankByCosine([1, 0], corpusRecords)]]);
    const metrics = evaluateRankings([{ id: "q", relevantChunkIds: ["a"] }], rankings, [1, 2]);
    check(metrics.recallAt1 === 1 && metrics.mrr === 1, "检索指标自检失败。");
}
