import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPOSITORY_ROOT } from "./config.mjs";

export function createRunId(prefix) {
    return `${prefix}-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
}

export async function writeResult(runId, fileName, payload) {
    const directory = path.join(REPOSITORY_ROOT, "benchmark-results/local-ai", runId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, fileName);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    return path.relative(REPOSITORY_ROOT, target);
}

export function environmentSnapshot(device) {
    return {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        device,
        transformersJs: "4.3.1",
    };
}
