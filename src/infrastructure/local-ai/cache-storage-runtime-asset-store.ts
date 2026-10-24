import type {
    LocalAiRuntimePolicy,
    PreparedRuntimeAssets,
    PrepareRuntimeAssetsOptions,
    RuntimeAssetDownloader,
    RuntimeAssetStore,
    RuntimeBinaryCache,
    RuntimeArtifactPolicy,
} from "../../domain/local-ai/local-ai-runtime-assets";

/** 使用浏览器 Cache Storage 保存运行时二进制，避免资产进入 Vault 和同步目录。 */
export class CacheStorageRuntimeBinaryCache implements RuntimeBinaryCache {
    constructor(private readonly cacheName: string) {}

    async read(key: string): Promise<ArrayBuffer | null> {
        const cache = await this.open();
        const response = await cache.match(key);
        return response ? await response.arrayBuffer() : null;
    }

    async write(key: string, value: ArrayBuffer, mediaType: string): Promise<void> {
        const cache = await this.open();
        await cache.put(key, new Response(value.slice(0), {
            headers: {
                "content-length": String(value.byteLength),
                "content-type": mediaType,
            },
        }));
    }

    async delete(key: string): Promise<void> {
        const cache = await this.open();
        await cache.delete(key);
    }

    async clear(): Promise<void> {
        requireCacheStorage();
        await caches.delete(this.cacheName);
    }

    private async open(): Promise<Cache> {
        requireCacheStorage();
        return await caches.open(this.cacheName);
    }
}

/**
 * 只返回通过字节数和 SHA-256 双重验证的 runtime。
 *
 * CDN 只是固定资产的传输来源；真正的信任根是随当前插件版本发布的 policy。
 */
export class VerifiedRuntimeAssetStore implements RuntimeAssetStore {
    constructor(
        private readonly policy: LocalAiRuntimePolicy,
        private readonly cache: RuntimeBinaryCache,
        private readonly downloader: RuntimeAssetDownloader,
    ) {}

    async prepare(options: PrepareRuntimeAssetsOptions): Promise<PreparedRuntimeAssets> {
        throwIfAborted(options.signal);
        const artifact = this.policy.artifact;
        const key = buildCacheKey(this.policy, artifact);
        const cached = await this.cache.read(key);
        if (cached) {
            const validation = await validateRuntimeBytes(cached, artifact);
            if (validation === null) {
                options.onProgress?.({
                    artifact: "runtime-wasm",
                    loadedBytes: artifact.bytes,
                    totalBytes: artifact.bytes,
                });
                return { policyId: this.policy.id, wasmBinary: cached, source: "cache" };
            }
            await this.cache.delete(key);
        }

        if (!options.allowDownload) {
            throw new Error("Built-in embedding runtime is not cached. Connect to the internet and prepare it once.");
        }

        options.onProgress?.({ artifact: "runtime-wasm", loadedBytes: 0, totalBytes: artifact.bytes });
        const failures: string[] = [];
        for (const url of artifact.urls) {
            throwIfAborted(options.signal);
            try {
                const downloaded = await this.downloader.download(url, options.signal);
                throwIfAborted(options.signal);
                const validation = await validateRuntimeBytes(downloaded, artifact);
                if (validation !== null) {
                    failures.push(`${safeHost(url)}: ${validation}`);
                    continue;
                }
                await this.cache.write(key, downloaded, artifact.mediaType);
                options.onProgress?.({
                    artifact: "runtime-wasm",
                    loadedBytes: artifact.bytes,
                    totalBytes: artifact.bytes,
                });
                return { policyId: this.policy.id, wasmBinary: downloaded, source: "download" };
            } catch (error) {
                if (isAbortError(error)) throw error;
                failures.push(`${safeHost(url)}: ${getErrorMessage(error)}`);
            }
        }

        throw new Error(`Could not download the pinned ONNX runtime. ${failures.join("; ")}`);
    }

    async clear(): Promise<void> {
        await this.cache.clear();
    }
}

function buildCacheKey(policy: LocalAiRuntimePolicy, artifact: RuntimeArtifactPolicy): string {
    return `https://vault-coach.local/runtime/${encodeURIComponent(policy.id)}/${encodeURIComponent(artifact.file)}`;
}

async function validateRuntimeBytes(
    value: ArrayBuffer,
    artifact: RuntimeArtifactPolicy,
): Promise<string | null> {
    if (value.byteLength !== artifact.bytes) {
        return `unexpected size ${value.byteLength}/${artifact.bytes}`;
    }
    const digest = await sha256(value);
    return digest === artifact.sha256 ? null : "SHA-256 mismatch";
}

async function sha256(value: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", value);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function requireCacheStorage(): void {
    if (typeof caches === "undefined") {
        throw new Error("Cache Storage is unavailable in this Obsidian runtime.");
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException("Runtime download was cancelled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function safeHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "invalid-runtime-source";
    }
}
