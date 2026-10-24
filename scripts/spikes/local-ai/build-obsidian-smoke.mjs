import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";
import { loadCandidate, REPOSITORY_ROOT } from "./lib/config.mjs";

const candidate = await loadCandidate("multilingual-e5-small-uint8");
const outputDirectory = path.join(REPOSITORY_ROOT, ".m4-smoke-plugin");
await mkdir(outputDirectory, { recursive: true });

await esbuild.build({
    entryPoints: [path.join(REPOSITORY_ROOT, "scripts/spikes/local-ai/worker-smoke.mjs")],
    outfile: path.join(outputDirectory, "worker-smoke.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    conditions: ["browser"],
    minify: false,
    sourcemap: false,
    logLevel: "info",
});

await esbuild.build({
    entryPoints: [path.join(REPOSITORY_ROOT, "scripts/spikes/local-ai/obsidian-smoke-plugin.mjs")],
    outfile: path.join(outputDirectory, "main.js"),
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2018",
    external: ["obsidian"],
    define: {
        "globalThis.__M4_CONFIG__": JSON.stringify({
            task: candidate.task,
            repository: candidate.repository,
            revision: candidate.revision,
            dtype: candidate.dtype,
            dimension: candidate.dimension,
            pooling: candidate.pooling,
            normalize: candidate.normalize,
            prefixes: candidate.prefixes,
            modelFileBytes: candidate.modelFileBytes,
        }),
    },
    minify: false,
    sourcemap: false,
    logLevel: "info",
});

const ortDirectory = path.join(REPOSITORY_ROOT, "node_modules/onnxruntime-web/dist");
for (const name of [
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
]) {
    await copyFile(path.join(ortDirectory, name), path.join(outputDirectory, name));
}

await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify({
    id: "vault-coach-m4-smoke",
    name: "Vault Coach M4 Smoke",
    version: "0.1.0",
    minAppVersion: "1.11.4",
    description: "Temporary local AI runtime validation plugin for Vault Coach milestone 4.",
    author: "Wanjin5508",
    isDesktopOnly: false,
}, null, 2)}\n`, "utf8");

const releaseFiles = [
    "manifest.json",
    "main.js",
    "worker-smoke.js",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
];
const assetManifest = { schemaVersion: 1, transformersJs: "4.3.1", files: [] };
for (const name of releaseFiles) {
    const content = await readFile(path.join(outputDirectory, name));
    assetManifest.files.push({
        name,
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
    });
}
await writeFile(
    path.join(outputDirectory, "asset-manifest.json"),
    `${JSON.stringify(assetManifest, null, 2)}\n`,
    "utf8",
);

console.log(`[M4] Obsidian smoke plugin built at ${path.relative(REPOSITORY_ROOT, outputDirectory)}`);
