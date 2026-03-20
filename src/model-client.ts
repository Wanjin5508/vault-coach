import { requestUrl } from "obsidian";
import type {
    LocalChatMessage,
    QueryRewriteResult,
    RerankResultItem,
    StreamHandlers,
    VaultCoachSettings,
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

interface OllamaStreamChunk {
    message?: {
        content?: string;
    };
    done?: boolean;
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

    // 新增：使用同一个聊天模型抽取可长期保存的记忆事实。
    async extractMemoryStatements(
        conversationContext: string,
        latestUserText: string,
        latestAssistantText: string,
    ): Promise<string[]> {
        const settings: VaultCoachSettings = this.getSettings();

        if (!settings.enableLongTermMemory || settings.chatModel.trim().length === 0) {
            return [];
        }

        const systemPrompt: string = [
            "你是一个长期记忆抽取器。",
            "你的目标是从对话中提炼对未来仍有用、且适合长期保存的用户信息。",
            "只保留稳定偏好、长期项目、明确目标、持续约束、反复出现的事实。",
            "不要保留一次性问题、临时闲聊、即时状态、模糊猜测。",
            "输出严格 JSON，格式为 {\"memories\": [\"...\", \"...\"]}。",
            "如果没有值得长期记住的信息，返回空数组。",
        ].join("\n");

        const userPrompt: string = [
            "最近对话上下文：",
            conversationContext || "（无）",
            "",
            `本轮用户输入：${latestUserText}`,
            `本轮助手回复：${latestAssistantText}`,
            "",
            "请只输出 JSON。",
        ].join("\n");

        try {
            const content: string = await this.chat({
                model: settings.chatModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                temperature: 0,
                format: "json",
            });

            const parsed: unknown = JSON.parse(content);
            if (
                parsed &&
                typeof parsed === "object" &&
                "memories" in parsed &&
                Array.isArray(parsed.memories)
            ) {
                return parsed.memories
                    .filter((value: unknown): value is string => typeof value === "string")
                    .map((value: string) => value.trim())
                    .filter((value: string) => value.length > 0);
            }
        } catch (error: unknown) {
            console.error("[VaultCoach] 记忆抽取失败", error);
        }

        return [];
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

    // 新增：最终回答使用流式输出，rewrite 仍保持非流式。
    // 替换streamMarkdownAnswer方法的实现
// async streamMarkdownAnswer(
//     messages: LocalChatMessage[],
//     temperature: number,
//     handlers?: StreamHandlers,
// ): Promise<string> {
//     const settings: VaultCoachSettings = this.getSettings();
//     const targetUrl: string = this.joinUrl(settings.llmBaseUrl, "/api/chat");
    
//     // 使用requestUrl替代fetch
//     const response = await requestUrl({
//         url: targetUrl,
//         method: "POST",
//         headers: {
//             "Content-Type": "application/json",
//         },
//         body: JSON.stringify({
//             model: settings.chatModel,
//             messages,
//             stream: true,
//             options: {
//                 temperature,
//             },
//         }),
//     });

//     // 由于requestUrl不直接支持流式处理，我们需要处理完整响应
//     // 注意：requestUrl返回的是完整的响应，无法真正实现流式处理
//     // 这里模拟流式处理行为
    
//     let finalText = "";
    
//     try {
//         // 将完整响应文本按行分割来模拟流式处理
//         const responseText = response.text;
//         const lines = responseText.split('\n');
        
//         for (const line of lines) {
//             const trimmedLine = line.trim();
//             if (trimmedLine.length === 0) {
//                 continue;
//             }
            
//             try {
//                 const parsed: OllamaStreamChunk = JSON.parse(trimmedLine) as OllamaStreamChunk;
                
//                 if (parsed.error) {
//                     throw new Error(parsed.error);
//                 }

//                 const token: string = parsed.message?.content ?? "";
//                 if (token.length > 0) {
//                     finalText += token;
//                     handlers?.onToken?.(token);
//                 }

//                 if (parsed.done) {
//                     handlers?.onDone?.();
//                     return finalText;
//                 }
//             } catch (parseError) {
//                 // 忽略解析错误，继续处理下一行
//                 continue;
//             }
//         }
        
//         handlers?.onDone?.();
//         return finalText;
//     } catch (error: unknown) {
//         handlers?.onError?.(error);
//         throw error;
//     }
// }
async streamMarkdownAnswer(
    messages: LocalChatMessage[],
    temperature: number,
    handlers?: StreamHandlers,
): Promise<string> {
    const settings = this.getSettings();
    const targetUrl = this.joinUrl(settings.llmBaseUrl, "/api/chat");

    // 用 globalThis 绕过 TS 类型检查，运行时完全正常
    // const nativeFetch = (globalThis as any).fetch as typeof window.fetch;
    // 改成这样，完全不碰 any
    const nativeFetch = globalThis.fetch.bind(globalThis) as (
        input: string,
        init?: RequestInit
    ) => Promise<Response>;
    
    const response = await nativeFetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: settings.chatModel,
            messages,
            stream: true,
            options: { temperature },
        }),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    // 真正的流式读取
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let finalText = "";
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            
            if (done) break;
            
            // value 是 Uint8Array，需要解码成字符串
            buffer += decoder.decode(value, { stream: true });
            
            // Ollama 返回的是 NDJSON，按换行符分割处理
            const lines = buffer.split("\n");
            
            // 最后一个元素可能是不完整的行，留到下次处理
            buffer = lines.pop() ?? "";
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                
                try {
                    const chunk = JSON.parse(trimmed) as {
                        message?: { content?: string };
                        done?: boolean;
                        error?: string;
                    };
                    
                    if (chunk.error) throw new Error(chunk.error);
                    
                    const token = chunk.message?.content ?? "";
                    if (token) {
                        finalText += token;
                        handlers?.onToken?.(token);
                    }
                    
                    if (chunk.done) {
                        handlers?.onDone?.();
                        return finalText;
                    }
                } catch {
                    // 单行解析失败不影响整体
                    continue;
                }
            }
        }
    } finally {
        await reader.cancel();
    }

    handlers?.onDone?.();
    return finalText;
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


