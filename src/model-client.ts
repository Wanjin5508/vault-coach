import { requestUrl } from "obsidian";
import type {
    LocalChatMessage,
    QueryRewriteResult,
    RerankResultItem,
    VaultCoachSettings
} from "./types"

interface OllamaChatResponse {
    message?: {
        content?: string;
    }

    error?: string;
}

interface OllamaEmbedResponse {
    embeddings?: number[][];
    error?: string;
}

interface RerankResponse {
    results?: RerankResultItem[];
}

/**
 * LocalModelClient 负责和本地模型服务通信。
 *
 * 当前版本默认按“Ollama 风格 REST 接口”实现：
 * - /api/chat     用于 query rewrite 与最终回答生成
 * - /api/embed    用于 embedding
 *
 * 对于 rerank：
 * - 由于不同本地部署方案的接口差异较大，因此这里采用“可选独立 rerank 服务”的策略；
 * - 如果用户未配置 rerankBaseUrl，则上层会回退到本地启发式重排。
 */

export class LocalModelClient {
    private readonly getSettings: () => VaultCoachSettings;

    constructor(getSettings: () => VaultCoachSettings) {
        this.getSettings = getSettings;
    }

    /**
     * 使用聊天模型做 query rewrite。
     *
     * 这里故意让改写目标非常克制：
     * - 保留用户真实意图；
     * - 补全上下文中的省略；
     * - 产出更适合检索的 query；
     * - 不引入原问题中不存在的新事实。
     */
    async rewriteQuery(
        originalQuery: string,
        conversationContext: string,
        scopeDescription: string,
    ): Promise<QueryRewriteResult> {
        const settings: VaultCoachSettings = this.getSettings();

        if (!settings.enableQueryRewrite || settings.chatModel.trim().length === 0) {
            return {
                originalQuery,
                rewrittenQuery: originalQuery,
                useRewrite: false,
            };
        }

        // TODO 替换成支持双语的提示词
        const systemPrompt = [
            "你是一名专门为本地知识库检索服务的 query rewrite 助手。",
            "你的任务不是回答问题，而是把用户问题改写成更适合检索的中文查询。",
            "要求：",
            "1. 保留原始意图，不要虚构新信息；",
            "2. 如果用户问题中存在代词、省略或上下文指代，可结合对话上下文补全；",
            "3. 优先产出适合在 Obsidian Markdown 笔记中检索的关键词短句；",
            "4. 输出严格 JSON，格式为 {\"rewritten_query\": \"...\"}。",
        ].join("\n");

        const userPrompt = [
            `当前知识库范围：${scopeDescription}`,
            "",
            "最近对话上下文：",
            conversationContext || "（无）",
            "",
            `原始问题：${originalQuery}`,
            "",
            "请只输出 JSON。",
        ].join("\n");

        try {
            const content: string = await this.chat({
                model: settings.chatModel,
                messages: [
                    {role: "system", content: systemPrompt},
                    {role: "user", content: userPrompt},
                ],
                temperature: 0,
                format: "json",
            });

            const parsed: unknown = JSON.parse(content);
            if (
                parsed
                && typeof parsed === "object"
                && "rewritten_query" in parsed
                && typeof parsed.rewritten_query === "string"
            ) {
                const rewrittenQuery: string = parsed.rewritten_query.trim();
                if (rewrittenQuery.length > 0) {
                    return {
                        originalQuery: originalQuery,
                        rewrittenQuery: rewrittenQuery,
                        useRewrite: rewrittenQuery !== originalQuery,
                    };
                }
            }
        } catch (error:unknown) {
            console.error("[VaultCoach] Query rewrite failed", error);
        }

        return {
            originalQuery: originalQuery,
            rewrittenQuery: originalQuery,
            useRewrite: false,
        };
    }

    /**
     * 调用本地聊天模型生成最终回答。
     *
     * 约定：返回值始终为 Markdown 文本。
     */
    async generateMarkdownAnswer(messages: LocalChatMessage[], temperature: number): Promise<string> {
        const settings: VaultCoachSettings = this.getSettings();
        return this.chat({
            model: settings.chatModel,
            messages,
            temperature,
        });
    }

    /**
     * 批量生成 embedding。
     *
     * Ollama 的 /api/embed 支持 string 或 string[] 输入，
     * 因此这里直接一次发送一个小批次，避免为每个 chunk 单独发请求。
     * ? 嵌入的格式是怎样的？ 性能如何？
     */
    async embedTexts(texts: string[]): Promise<number[][]> {
        const settings: VaultCoachSettings = this.getSettings();
        if (!settings.enableVectorRetrieval || settings.embeddingModel.trim().length === 0) {
            return [];
        } 

        if (texts.length === 0) {
            return [];
        }

        const responseText: string = await this.postJson(
            settings.llmBaseUrl,
            "/api/embed",
            {
                model: settings.embeddingModel,
                input: texts,
                truncate: true,
            },
        );

        const parsed: OllamaEmbedResponse = JSON.parse(responseText) as OllamaEmbedResponse;
        if (parsed.error) {
            throw new Error(parsed.error);

        }
        const embeddings: number[][] | undefined = parsed.embeddings;
        if (!embeddings || embeddings.length === 0) {
            throw new Error("embedding 接口返回为空。");
        }

        return embeddings;
    }

    /**
     * 调用独立 rerank 服务。
     *
     * 这里采用常见的 /v1/rerank 风格：
     * {
     *   model: string,
     *   query: string,
     *   documents: string[]
     * }
     */
    async rerankDocuments(query: string, documents: string[]): Promise<RerankResultItem[]> {
        const settings: VaultCoachSettings = this.getSettings();
        const trimmedBaseUrl: string = settings.rerankBaseUrl.trim();
        if (trimmedBaseUrl.length === 0 || settings.rerankModel.trim().length === 0) {
            throw new Error("未配置 rerankBaseUrl 或 rerankModel。");
        }

        const rerankPath: string = trimmedBaseUrl.endsWith("/v1/rerank")
            ? ""
            : "/v1/rerank";

        const responseText: string = await this.postJson(
            trimmedBaseUrl,
            rerankPath,
            {
                model: settings.rerankModel,
                query,
                documents,
            },
        );

        const parsed: RerankResponse = JSON.parse(responseText) as RerankResponse;
        return parsed.results ?? [];
    }


    /**
     * 与 Ollama 风格聊天接口交互。
     *
     * 这里统一走非流式：
     * - 对插件 UI 来说更简单；
     * - 更适合 query rewrite 这类短输出；
     * - 也更方便做 MarkdownRenderer 一次性渲染。
     */
    private async chat(options: {
        model: string;
        messages: LocalChatMessage[];
        temperature: number;
        format?: "json"
    }): Promise<string> {
        const settings: VaultCoachSettings = this.getSettings();
        const responseText: string = await this.postJson(
            settings.llmBaseUrl,
            "/api/chat",
            {
                model: options.model,
                messages: options.messages,
                stream: false,
                format: options.format,
                options: {
                    temperature: options.temperature,
                },
            },
        );

        const parsed: OllamaChatResponse = JSON.parse(responseText) as OllamaChatResponse
        if (parsed.error) {
            throw new Error(parsed.error);
        }

        const content: string | undefined = parsed.message?.content;
        if (content === undefined) {
            throw new Error("Invalid response from Ollama");
        }

        return content;

    }

    /**
     * 统一发送 JSON POST 请求。
     *
     * 为什么不用 fetch：
     * - Obsidian 官方插件开发建议优先使用 requestUrl；
     * - 这样可以绕过浏览器侧 CORS 限制，更适合桌面端插件访问本地服务。
     */
    private async postJson(baseUrl: string, path: string, payload: unknown): Promise<string> {
        const targetUrl: string = this.joinUrl(baseUrl, path);
        const response = await requestUrl({
            url: targetUrl,
            method: "POST",
            body: JSON.stringify(payload),
            headers: {"Content-Type": "application/json"},
        });

        return response.text;
    }

    /**
     * 拼接 URL，避免因为双斜杠或缺少斜杠导致请求地址错误。
     */
    private joinUrl(baseUrl: string, path: string): string {
        const normalizedBase: string = baseUrl.trim().replace(/\/+$/, "");
        const normalizedPath: string = path.trim();

        if (normalizedPath.length === 0) {
            return normalizedBase;
        }

        if (normalizedPath.startsWith("/")) {
            return `${normalizedBase}${normalizedPath}`;
        }

        return `${normalizedBase}/${normalizedPath}`;
    }

}


