import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** M4 脚本统一从仓库根目录解析文件，避免调用者当前目录改变实验输入。 */
export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export async function readJson(relativePath) {
    return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8"));
}

export async function readJsonLines(relativePath) {
    const source = await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8");
    return source.split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            try {
                return JSON.parse(line);
            } catch (error) {
                throw new Error(`${relativePath}:${index + 1} 不是有效 JSON。`, { cause: error });
            }
        });
}

export async function loadProtocol() {
    return readJson("benchmarks/local-ai/protocol.json");
}

export async function loadModelLedger() {
    return readJson("benchmarks/local-ai/models.json");
}

export async function loadCandidate(candidateId) {
    const ledger = await loadModelLedger();
    const candidate = ledger.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
        throw new Error(`未知模型候选：${candidateId}`);
    }
    return candidate;
}

export async function loadRetrievalDataset(protocol) {
    const corpus = await readJsonLines(protocol.dataset.corpus);
    const queries = [];
    for (const [language, relativePath] of Object.entries(protocol.dataset.queries)) {
        for (const query of await readJsonLines(relativePath)) {
            queries.push({ ...query, language });
        }
    }
    return { corpus, queries };
}
