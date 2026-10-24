import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const revision = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const repository = "Xenova/multilingual-e5-small";
const modelRoot = path.join(repositoryRoot, ".m4-model-cache", repository, revision);
const runtimePath = path.join(repositoryRoot, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm");
const modelFiles = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_uint8.onnx"];

for (const file of [...modelFiles.map((name) => path.join(modelRoot, name)), runtimePath]) {
    if (!existsSync(file)) {
        throw new Error(`Smoke asset is missing: ${file}. Run the M4 embedding smoke with downloads enabled first.`);
    }
}

const outputRoot = await mkdtemp(path.join(tmpdir(), "vault-coach-runtime-smoke-"));
const assetsRoot = path.join(outputRoot, "assets");
await mkdir(assetsRoot, { recursive: true });
await symlink(modelRoot, path.join(assetsRoot, "model"), "dir");
await symlink(runtimePath, path.join(assetsRoot, "runtime.wasm"));

await esbuild.build({
    entryPoints: [path.join(repositoryRoot, "src/infrastructure/local-ai/local-ai.worker.ts")],
    outfile: path.join(outputRoot, "worker.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    conditions: ["browser"],
    alias: { "onnxruntime-web/webgpu": "onnxruntime-web/wasm" },
    define: { process: "undefined" },
    minify: true,
    sourcemap: false,
});

await writeFile(path.join(outputRoot, "index.html"), buildHarness(), "utf8");

let reportResult;
const reportedResult = new Promise((resolve) => { reportResult = resolve; });

const server = createServer(async (request, response) => {
    try {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname === "/result") {
            const value = requestUrl.searchParams.get("value") ?? "FAIL|missing result";
            response.writeHead(204);
            response.end();
            reportResult(value);
            return;
        }
        const requestPath = decodeURIComponent(requestUrl.pathname);
        const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
        const absolutePath = path.resolve(outputRoot, relativePath);
        if (!absolutePath.startsWith(`${outputRoot}${path.sep}`)) throw new Error("Invalid smoke path.");
        const bytes = await readFile(absolutePath);
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": mediaType(absolutePath),
        });
        response.end(bytes);
    } catch (error) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : String(error));
    }
});

try {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to determine smoke server port.");
    const chrome = findChrome();
    const browser = spawn(chrome, [
        "--headless=new",
        "--disable-gpu",
        `--user-data-dir=${path.join(outputRoot, "chrome-profile")}`,
        `http://127.0.0.1:${address.port}/`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let browserStderr = "";
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk) => { browserStderr += chunk; });
    const browserError = new Promise((_, reject) => browser.once("error", reject));
    const browserClosed = new Promise((resolve) => browser.once("close", resolve));
    try {
        const result = await withTimeout(Promise.race([reportedResult, browserError]), 120_000);
        if (!result.startsWith("PASS|")) {
            throw new Error(`Browser runtime smoke failed: ${result}\n${browserStderr}`);
        }
        console.log(result);
    } finally {
        browser.kill();
        await browserClosed;
    }
} finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(outputRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function buildHarness() {
    const remoteBase = `https://huggingface.co/${repository}/resolve/${revision}/`;
    return `<!doctype html><meta charset="utf-8"><body>PENDING</body><script type="module">
const files = ${JSON.stringify(modelFiles)};
const remoteBase = ${JSON.stringify(remoteBase)};
const cache = await caches.open("vault-coach-local-ai-v1");
for (const file of files) {
  const response = await fetch("/assets/model/" + file);
  if (!response.ok) throw new Error("fixture fetch failed: " + file);
  await cache.put(remoteBase + file, response);
}
const wasmResponse = await fetch("/assets/runtime.wasm");
const wasmBinary = await wasmResponse.arrayBuffer();
const worker = new Worker("/worker.js");
let sequence = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  if (data.type === "fatal") finish(new Error(data.error?.message || "worker fatal"));
  if (data.type !== "response") return;
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  data.ok ? request.resolve(data.result) : request.reject(new Error(data.error?.message || "worker request failed"));
};
worker.onerror = (event) => finish(new Error(event.message || "worker error"));
function request(type, payload, transfer = []) {
  const id = "smoke-" + (++sequence);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
}
function finish(error, vector) {
  const result = error
    ? "FAIL|" + error.message
    : "PASS|dimension=" + vector.length + "|finite=" + vector.every(Number.isFinite) + "|transferred=true";
  document.body.textContent = result;
  fetch("/result?value=" + encodeURIComponent(result)).catch(() => {});
  worker.terminate();
}
try {
  const prepare = request("prepare", {
    allowDownload: false,
    runtime: {
      policyId: "onnxruntime-web-1.31.0-dev.20260914-8d85527a0-wasm-v1",
      wasmBinary,
    },
  }, [wasmBinary]);
  const runtimeTransferred = wasmBinary.byteLength === 0;
  await prepare;
  const result = await request("embed", { texts: ["Vault Coach runtime smoke"], purpose: "query" });
  const vector = result.vectors?.[0];
  if (!Array.isArray(vector) || vector.length !== 384) throw new Error("invalid vector");
  if (!runtimeTransferred) throw new Error("runtime buffer was copied instead of transferred");
  finish(null, vector);
} catch (error) {
  finish(error instanceof Error ? error : new Error(String(error)));
}
</script>`;
}

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ].filter(Boolean);
    const chrome = candidates.find((candidate) => existsSync(candidate));
    if (!chrome) throw new Error("Chrome/Chromium was not found. Set CHROME_PATH to run this smoke test.");
    return chrome;
}

function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Browser runtime smoke timed out after ${timeoutMs} ms.`)), timeoutMs);
        promise.then(
            (value) => { clearTimeout(timeout); resolve(value); },
            (error) => { clearTimeout(timeout); reject(error); },
        );
    });
}

function mediaType(file) {
    if (file.endsWith(".html")) return "text/html; charset=utf-8";
    if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
    if (file.endsWith(".json")) return "application/json";
    if (file.endsWith(".wasm")) return "application/wasm";
    return "application/octet-stream";
}
