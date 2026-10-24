import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type {
    LocalAiRuntimePolicy,
    RuntimeAssetDownloader,
    RuntimeBinaryCache,
} from "../../../src/domain/local-ai/local-ai-runtime-assets";
import { VerifiedRuntimeAssetStore } from "../../../src/infrastructure/local-ai/cache-storage-runtime-asset-store";

const validBytes = Uint8Array.from([1, 2, 3]).buffer;
const validSha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";

beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: webcrypto,
    });
});

const policy: LocalAiRuntimePolicy = {
    id: "test-ort-v1",
    engine: "onnxruntime-web",
    version: "test",
    backend: "wasm",
    cacheName: "test-runtime-cache",
    artifact: {
        file: "ort.wasm",
        urls: ["https://primary.example/ort.wasm", "https://fallback.example/ort.wasm"],
        bytes: 3,
        sha256: validSha256,
        mediaType: "application/wasm",
    },
};

class MemoryRuntimeCache implements RuntimeBinaryCache {
    value: ArrayBuffer | null = null;
    writes = 0;
    deletes = 0;
    clears = 0;

    async read(): Promise<ArrayBuffer | null> { return this.value?.slice(0) ?? null; }
    async write(_key: string, value: ArrayBuffer): Promise<void> {
        this.value = value.slice(0);
        this.writes += 1;
    }
    async delete(): Promise<void> { this.value = null; this.deletes += 1; }
    async clear(): Promise<void> { this.value = null; this.clears += 1; }
}

class FakeDownloader implements RuntimeAssetDownloader {
    readonly calls: string[] = [];

    constructor(private readonly responses: Readonly<Record<string, ArrayBuffer | Error>>) {}

    async download(url: string): Promise<ArrayBuffer> {
        this.calls.push(url);
        const response = this.responses[url];
        if (!response) throw new Error("missing fake response");
        if (response instanceof Error) throw response;
        return response.slice(0);
    }
}

describe("VerifiedRuntimeAssetStore", () => {
    it("returns a verified warm cache without using the network", async () => {
        const cache = new MemoryRuntimeCache();
        cache.value = validBytes.slice(0);
        const downloader = new FakeDownloader({});
        const store = new VerifiedRuntimeAssetStore(policy, cache, downloader);

        const result = await store.prepare({ allowDownload: false });

        expect(result.source).toBe("cache");
        expect(new Uint8Array(result.wasmBinary)).toEqual(new Uint8Array(validBytes));
        expect(downloader.calls).toEqual([]);
    });

    it("downloads, verifies, and caches a cold runtime", async () => {
        const cache = new MemoryRuntimeCache();
        const downloader = new FakeDownloader({
            [policy.artifact.urls[0]!]: validBytes,
        });
        const store = new VerifiedRuntimeAssetStore(policy, cache, downloader);

        const result = await store.prepare({ allowDownload: true });

        expect(result.source).toBe("download");
        expect(cache.writes).toBe(1);
        expect(downloader.calls).toEqual([policy.artifact.urls[0]]);
    });

    it("deletes a corrupt cache and refuses it while offline", async () => {
        const cache = new MemoryRuntimeCache();
        cache.value = Uint8Array.from([9, 8]).buffer;
        const store = new VerifiedRuntimeAssetStore(policy, cache, new FakeDownloader({}));

        await expect(store.prepare({ allowDownload: false })).rejects.toThrow("runtime is not cached");
        expect(cache.deletes).toBe(1);
    });

    it("replaces a corrupt cache from a verified pinned source while online", async () => {
        const cache = new MemoryRuntimeCache();
        cache.value = Uint8Array.from([3, 2, 1]).buffer;
        const downloader = new FakeDownloader({
            [policy.artifact.urls[0]!]: validBytes,
        });
        const store = new VerifiedRuntimeAssetStore(policy, cache, downloader);

        await expect(store.prepare({ allowDownload: true })).resolves.toMatchObject({ source: "download" });
        expect(cache.deletes).toBe(1);
        expect(cache.writes).toBe(1);
        expect(new Uint8Array(cache.value)).toEqual(new Uint8Array(validBytes));
    });

    it("falls back to the second pinned source after a transport failure", async () => {
        const cache = new MemoryRuntimeCache();
        const downloader = new FakeDownloader({
            [policy.artifact.urls[0]!]: new Error("primary unavailable"),
            [policy.artifact.urls[1]!]: validBytes,
        });
        const store = new VerifiedRuntimeAssetStore(policy, cache, downloader);

        await expect(store.prepare({ allowDownload: true })).resolves.toMatchObject({ source: "download" });
        expect(downloader.calls).toEqual([...policy.artifact.urls]);
    });

    it("rejects same-sized bytes with the wrong SHA-256", async () => {
        const cache = new MemoryRuntimeCache();
        const invalid = Uint8Array.from([3, 2, 1]).buffer;
        const downloader = new FakeDownloader({
            [policy.artifact.urls[0]!]: invalid,
            [policy.artifact.urls[1]!]: invalid,
        });
        const store = new VerifiedRuntimeAssetStore(policy, cache, downloader);

        await expect(store.prepare({ allowDownload: true })).rejects.toThrow("SHA-256 mismatch");
        expect(cache.writes).toBe(0);
    });

    it("clears only the runtime cache namespace", async () => {
        const cache = new MemoryRuntimeCache();
        const store = new VerifiedRuntimeAssetStore(policy, cache, new FakeDownloader({}));

        await store.clear();

        expect(cache.clears).toBe(1);
    });

    it("stops before cache or network work when already aborted", async () => {
        const cache = new MemoryRuntimeCache();
        const downloader = new FakeDownloader({});
        const store = new VerifiedRuntimeAssetStore(policy, cache, downloader);
        const controller = new AbortController();
        controller.abort();

        await expect(store.prepare({ allowDownload: true, signal: controller.signal }))
            .rejects.toMatchObject({ name: "AbortError" });
        expect(downloader.calls).toEqual([]);
        expect(cache.writes).toBe(0);
    });
});
