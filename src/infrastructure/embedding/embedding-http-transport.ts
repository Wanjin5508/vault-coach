import { requestUrl } from "obsidian";

export interface EmbeddingHttpRequest {
    baseUrl: string;
    path: string;
    payload: unknown;
    headers?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
}

export interface EmbeddingHttpResponse {
    status: number;
    text: string;
}

export interface EmbeddingHttpTransport {
    postJson(request: EmbeddingHttpRequest): Promise<EmbeddingHttpResponse>;
}

export class EmbeddingHttpTransportError extends Error {
    readonly status: number | null;

    constructor(status: number | null, message: string) {
        super(message);
        this.name = "EmbeddingHttpTransportError";
        this.status = status;
        Object.setPrototypeOf(this, EmbeddingHttpTransportError.prototype);
    }
}

/** 使用 Obsidian requestUrl 的生产 HTTP 边界，便于 adapter contract 注入 fake。 */
export class ObsidianEmbeddingHttpTransport implements EmbeddingHttpTransport {
    async postJson(request: EmbeddingHttpRequest): Promise<EmbeddingHttpResponse> {
        throwIfAborted(request.signal);
        const targetUrl: string = joinUrl(request.baseUrl, request.path);
        try {
            const response = await requestUrl({
                url: targetUrl,
                method: "POST",
                body: JSON.stringify(request.payload),
                headers: { "Content-Type": "application/json", ...request.headers },
                throw: false,
            });
            throwIfAborted(request.signal);
            if (response.status >= 400) {
                throw new EmbeddingHttpTransportError(response.status, safeHttpMessage(response.status, response.text));
            }
            return { status: response.status, text: response.text };
        } catch (error: unknown) {
            if (error instanceof EmbeddingHttpTransportError || isAbortError(error)) throw error;
            throw new EmbeddingHttpTransportError(null, `Embedding request failed: POST ${redactUrl(targetUrl)}`);
        }
    }
}

export function canonicalizeEndpointIdentity(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (!trimmed) return "unconfigured";
    try {
        const url = new URL(trimmed);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return trimmed.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") || "invalid-endpoint";
    }
}

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function redactUrl(targetUrl: string): string {
    return canonicalizeEndpointIdentity(targetUrl);
}

function safeHttpMessage(status: number, responseText: string): string {
    const normalized = responseText.replace(/\s+/g, " ").trim().slice(0, 500);
    const backendHint = normalized.match(/cuda|gpu|ptx|ggml|runner|backend/i)?.[0]?.toLowerCase();
    return `Embedding request failed with HTTP ${status}${backendHint ? ` (${backendHint})` : ""}`;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException("VaultCoach embedding request was cancelled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}
