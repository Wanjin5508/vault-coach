import { requestUrl } from "obsidian";
import type { RuntimeAssetDownloader } from "../../domain/local-ai/local-ai-runtime-assets";

/** 使用 Obsidian 网络边界获取 policy 固定的 runtime；调用方负责完整性验证。 */
export class ObsidianRuntimeAssetDownloader implements RuntimeAssetDownloader {
    async download(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
        throwIfAborted(signal);
        const response = await requestUrl({ url, method: "GET", throw: false });
        throwIfAborted(signal);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Runtime source returned HTTP ${response.status}.`);
        }
        return response.arrayBuffer;
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException("Runtime download was cancelled.", "AbortError");
}
