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

interface OllamaLegacyEmbeddingResponse {
    embedding?: number[];
    error?: string;
}

// interface OllamaStreamChunk {
//     message?: {
//         content?: string;
//     };
//     done?: boolean;
//     error?: string;
// }

interface RerankResponse {
    results?: RerankResultItem[];
}

interface ChatOptions {
    messages: LocalChatMessage[];
    temperature: number;
    format?: "json";
}

interface CloudChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
        };
    }>;

    error?: {
        message?: string;
    };
}

interface CloudEmbeddingResponse {
    data?: Array<{
        embedding?: number[];
    }>;

    error?: {
        message?: string;
    };
}

class ModelRequestError extends Error {
    readonly status: number | null;
    readonly url: string;

    constructor(url: string, status: number | null, message: string) {
        super(message);
        this.name = "ModelRequestError";
        this.status = status;
        this.url = url;
        Object.setPrototypeOf(this, ModelRequestError.prototype);
    }
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
    // 函数类型的成员变量，主要是为了拿到当前最新的设置，
    // 而不是构造 LocalModelClient 时的一份旧快照。
    // 是一种常见的依赖注入写法
    private readonly getSettings: () => VaultCoachSettings;
    private readonly getCloudApiKey: () => string | null;  // 只读，成员变量不能被重新赋值

    constructor(getSettings: () => VaultCoachSettings, getCloudApiKey: () => string | null) {
        this.getSettings = getSettings;
        this.getCloudApiKey = getCloudApiKey;
    }

    // 新增两个 helper 方法：以后判断聊天模型是否存在时，不再只看 settings.chatModel，而是根据当前 provider 判断。
    private getActiveChatModel(settings: VaultCoachSettings): string {
        return settings.modelProvider === "openai-compatible"
            ? settings.cloudChatModel.trim()
            : settings.chatModel.trim();
    }

    private shouldUseCloudChat(settings: VaultCoachSettings): boolean {
        return settings.modelProvider === "openai-compatible"
    }

    private getActiveEmbeddingModel(settings: VaultCoachSettings): string {
        return settings.embeddingProvider === "openai-compatible"
            ? settings.cloudEmbeddingModel.trim()
            : settings.embeddingModel.trim();
    }

    private shouldUseCloudEmbedding(settings: VaultCoachSettings): boolean {
        return settings.embeddingProvider === "openai-compatible";
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
        const activeChatModel: string = this.getActiveChatModel(settings);
        if (!settings.enableQueryRewrite || activeChatModel.length === 0) {
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
                // model: settings.chatModel,
                messages: [
                    {role: "system", content: systemPrompt},
                    {role: "user", content: userPrompt},
                ],
                temperature: 0, // TODO 即使温度设为 0，输出仍然会有扰动，原因在于 Transformer 架构中的不确定性
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

    // 使用同一个聊天模型抽取可长期保存的记忆事实。
    async extractMemoryStatements(
        conversationContext: string,
        latestUserText: string,
        latestAssistantText: string,
    ): Promise<string[]> {
        const settings: VaultCoachSettings = this.getSettings();
        const activeChatModel: string = this.getActiveChatModel(settings);

        if (!settings.enableLongTermMemory || activeChatModel.length === 0) {
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
                // model: settings.chatModel,
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
        // const settings: VaultCoachSettings = this.getSettings();
        return this.chat({
            // model: settings.chatModel,
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
    try {
        const finalText: string = await this.chat({
            messages,
            temperature,
        });

        if (finalText.length > 0) {
            handlers?.onToken?.(finalText);
        }

        handlers?.onDone?.();
        return finalText;
    } catch (error: unknown) {
        handlers?.onError?.(error);
        throw error;
    }
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
        const activeEmbeddingModel: string = this.getActiveEmbeddingModel(settings);
        if (!settings.enableVectorRetrieval || activeEmbeddingModel.length === 0) {
            return [];
        } 

        if (texts.length === 0) {
            return [];
        }

        if (this.shouldUseCloudEmbedding(settings)) {
            return this.embedTextsWithCloudApi(settings, texts);
        }

        try {
            return await this.embedTextsWithModernOllamaApi(settings, texts);
        } catch (error: unknown) {
            if (!this.isNotFoundError(error)) {
                throw error;
            }

            console.warn("[VaultCoach] /api/embed 不可用，尝试使用旧版 /api/embeddings 接口。", error);
            return this.embedTextsWithLegacyOllamaApi(settings, texts);
        }
    }

    private async embedTextsWithModernOllamaApi(
        settings: VaultCoachSettings,
        texts: string[],
    ): Promise<number[][]> {
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

    private async embedTextsWithCloudApi(
        settings: VaultCoachSettings,
        texts: string[],
    ): Promise<number[][]> {
        const apiKey: string | null = this.getCloudApiKey();

        if (settings.cloudEmbeddingModel.trim().length === 0) {
            throw new Error("未配置云端 embedding 模型。");
        }

        if (!apiKey) {
            throw new Error("未配置云端模型 API key。请先在设置页选择 SecretStorage 条目。");
        }

        const responseText: string = await this.postJson(
            settings.cloudEmbeddingBaseUrl,
            this.getCloudEmbeddingsPath(settings.cloudEmbeddingBaseUrl),
            {
                model: settings.cloudEmbeddingModel,
                input: texts,
            },
            { Authorization: `Bearer ${apiKey}` },
        );

        const parsed: CloudEmbeddingResponse = JSON.parse(responseText) as CloudEmbeddingResponse;
        if (parsed.error?.message) {
            throw new Error(parsed.error.message);
        }

        const embeddings: number[][] = (parsed.data ?? [])
            .map((item: { embedding?: number[] }) => item.embedding)
            .filter((embedding: number[] | undefined): embedding is number[] => {
                return Array.isArray(embedding) && embedding.length > 0;
            });

        if (embeddings.length === 0) {
            throw new Error("云端 embedding 接口返回为空。");
        }

        return embeddings;
    }

    private async embedTextsWithLegacyOllamaApi(
        settings: VaultCoachSettings,
        texts: string[],
    ): Promise<number[][]> {
        const embeddings: number[][] = [];

        for (const text of texts) {
            const responseText: string = await this.postJson(
                settings.llmBaseUrl,
                "/api/embeddings",
                {
                    model: settings.embeddingModel,
                    prompt: text,
                },
            );

            const parsed: OllamaLegacyEmbeddingResponse = JSON.parse(responseText) as OllamaLegacyEmbeddingResponse;
            if (parsed.error) {
                throw new Error(parsed.error);
            }

            if (!parsed.embedding || parsed.embedding.length === 0) {
                throw new Error("旧版 embedding 接口返回为空。");
            }

            embeddings.push(parsed.embedding);
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
     * 替换原有的 chat 方法，改为 provider 分发
     * 
     */
    private async chat(options: ChatOptions): Promise<string> {
        const settings = this.getSettings();
        if (this.shouldUseCloudChat(settings)) {
            return this.chatCloud(options);
        }
        return this.chatOllama(options);
    }


    /**
     * 与 Ollama 风格聊天接口交互。
     *
     * 这里统一走非流式：
     * - 对插件 UI 来说更简单；
     * - 更适合 query rewrite 这类短输出；
     * - 也更方便做 MarkdownRenderer 一次性渲染。
     */
    private async chatOllama(options: ChatOptions): Promise<string> {
    const settings: VaultCoachSettings = this.getSettings();

    if (settings.chatModel.trim().length === 0) {
        throw new Error("未配置本地聊天模型。");
    }

    const responseText: string = await this.postJson(
        settings.llmBaseUrl,
        "/api/chat",
        {
            model: settings.chatModel,
            messages: options.messages,
            stream: false,
            format: options.format,
            options: {
                temperature: options.temperature,
            },
        },
    );

    const parsed: OllamaChatResponse = JSON.parse(responseText) as OllamaChatResponse;

    if (parsed.error) {
        throw new Error(parsed.error);
    }

    const content: string | undefined = parsed.message?.content;
    if (content === undefined) {
        throw new Error("Invalid response from Ollama");
    }

    return content;
}
    private async chatCloud(options: ChatOptions): Promise<string> {
        const settings: VaultCoachSettings = this.getSettings();
        const apiKey: string | null = this.getCloudApiKey();

        if (settings.cloudChatModel.trim().length === 0) {
            throw new Error("未配置云端聊天模型。")
        }

        if (!apiKey) {
            throw new Error("未配置云端模型 API key。请先在设置页选择 SecretStorage 条目。");
        }

        const responseText: string = await this.postJson(
            settings.cloudBaseUrl,
            this.getCloudChatCompletionsPath(settings.cloudBaseUrl),
            {
                model: settings.cloudChatModel,
                messages: options.messages,
                temperature: options.temperature,
                response_format: options.format === "json" 
                    ? { type: "json_object" } 
                    : undefined,
            },
            { Authorization: `Bearer ${apiKey}` },
        );

        const parsed: CloudChatCompletionResponse= JSON.parse(responseText) as CloudChatCompletionResponse;

        if (parsed.error?.message) throw new Error(parsed.error.message);

        const content: string | null | undefined = parsed.choices?.[0]?.message?.content;
        if (!content) throw new Error("Invalid response from cloud model");
        return content;
    }

    private getCloudChatCompletionsPath(baseUrl: string): string {
        const normalizedBase: string = baseUrl.trim().replace(/\/+$/, "");

        if (normalizedBase.endsWith("/chat/completions")){
            return "";
        }

        if (normalizedBase.endsWith("/v1")) {
            return "/chat/completions";
        }

        return "/v1/chat/completions";
    }

    private getCloudEmbeddingsPath(baseUrl: string): string {
        const normalizedBase: string = baseUrl.trim().replace(/\/+$/, "");

        if (normalizedBase.endsWith("/embeddings")) {
            return "";
        }

        if (normalizedBase.endsWith("/v1")) {
            return "/embeddings";
        }

        return "/v1/embeddings";
    }

    /**
     * 统一发送 JSON POST 请求。
     *
     * 为什么不用 fetch：
     * - Obsidian 官方插件开发建议优先使用 requestUrl；
     * - 这样可以绕过浏览器侧 CORS 限制，更适合桌面端插件访问本地服务。
     */
    private async postJson(
        baseUrl: string, 
        path: string, 
        payload: unknown,
        headers: Record<string, string> = {},
    ): Promise<string> {
        const targetUrl: string = this.joinUrl(baseUrl, path);
        try {
            const response = await requestUrl({
                url: targetUrl,
                method: "POST",
                body: JSON.stringify(payload),
                headers: {
                    "Content-Type": "application/json",
                    ...headers,
                },
            });

            return response.text;
        } catch (error: unknown) {
            throw this.createRequestError(targetUrl, error);
        }
    }

    private createRequestError(targetUrl: string, error: unknown): ModelRequestError {
        const status: number | null = this.extractStatusCode(error);
        const originalMessage: string = this.getErrorMessage(error);
        const hint: string = this.buildRequestFailureHint(targetUrl, status);
        const messageParts: string[] = [
            `模型请求失败：POST ${targetUrl}`,
            status === null ? "" : `HTTP ${status}`,
            originalMessage,
            hint,
        ].filter((part: string) => part.length > 0);

        return new ModelRequestError(targetUrl, status, messageParts.join("。"));
    }

    private buildRequestFailureHint(targetUrl: string, status: number | null): string {
        if (status !== 404) {
            return "";
        }

        if (targetUrl.includes("/api/embed")) {
            return "如果你使用的是旧版 Ollama，插件会自动尝试 /api/embeddings；如果仍失败，请确认本地推理服务地址只填写根地址，例如 http://127.0.0.1:11434。";
        }

        if (targetUrl.includes("/api/chat")) {
            return "请确认本地推理服务地址只填写 Ollama 根地址，例如 http://127.0.0.1:11434，不要带 /api/chat。";
        }

        if (targetUrl.includes("/chat/completions")) {
            return "请确认云端模型服务地址与模型提供商匹配，例如 OpenAI 兼容服务通常填写到 /v1 或服务根地址。";
        }

        if (targetUrl.includes("/embeddings")) {
            return "请确认云端 embedding 服务地址与模型提供商匹配，例如 OpenAI 兼容服务通常填写到 /v1 或服务根地址。";
        }

        return "请确认对应模型服务地址和接口路径是否正确。";
    }

    private isNotFoundError(error: unknown): boolean {
        if (error instanceof ModelRequestError) {
            return error.status === 404;
        }

        return this.extractStatusCode(error) === 404;
    }

    private extractStatusCode(error: unknown): number | null {
        if (
            error
            && typeof error === "object"
            && "status" in error
            && typeof error.status === "number"
        ) {
            return error.status;
        }

        const message: string = this.getErrorMessage(error);
        const match: RegExpMatchArray | null = message.match(/status\s+(\d{3})/i);
        if (!match) {
            return null;
        }

        const statusText: string | undefined = match[1];
        if (!statusText) {
            return null;
        }

        return Number(statusText);
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
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
