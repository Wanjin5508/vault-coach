import { requestUrl } from "obsidian";
import type {
    LocalChatMessage,
    QueryRewriteResult,
    RerankResultItem,
    StreamHandlers,
    VaultCoachSettings,
} from "./types"
import { detectQuestionLanguage, type QuestionLanguage } from "./question-language";

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

interface CloudChatCompletionStreamChunk {
    choices?: Array<{
        delta?: {
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

    // 这两个字段只影响本插件会话内的 Ollama embedding。
    // fallbackUsed 用于向 UI 发一次 Notice；preferCpu 用于后续 batch 直接走 CPU，避免反复触发 GPU 崩溃。
    private ollamaEmbeddingCpuFallbackUsed = false;
    private preferOllamaEmbeddingCpu = false;

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

    consumeOllamaEmbeddingCpuFallbackUsed(): boolean {
        const fallbackWasUsed: boolean = this.ollamaEmbeddingCpuFallbackUsed;
        this.ollamaEmbeddingCpuFallbackUsed = false;
        return fallbackWasUsed;
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

        const questionLanguage: QuestionLanguage = detectQuestionLanguage(originalQuery);
        const systemPrompt: string = this.buildQueryRewriteSystemPrompt(questionLanguage);
        const userPrompt: string = this.buildQueryRewriteUserPrompt(
            originalQuery,
            conversationContext,
            scopeDescription,
            questionLanguage,
        );

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

    private buildQueryRewriteSystemPrompt(questionLanguage: QuestionLanguage): string {
        if (questionLanguage === "en") {
            return [
                "You are a query rewrite assistant for local knowledge-base retrieval.",
                "Your task is not to answer the question. Rewrite the user question into a concise retrieval query.",
                "Requirements:",
                "1. Preserve the original intent and do not invent new facts.",
                "2. If the user question contains pronouns, ellipsis, or references to recent context, resolve them using the conversation context.",
                "3. Prefer keywords and short phrases that work well for searching Obsidian Markdown notes.",
                "4. Preserve the user's question language. Do not force the query into Chinese.",
                "5. Keep important technical terms, abbreviations, and common aliases. Bilingual aliases are allowed when helpful for retrieval.",
                "6. Output strict JSON in this format: {\"rewritten_query\": \"...\"}.",
            ].join("\n");
        }

        return [
            "你是一名专门为本地知识库检索服务的 query rewrite 助手。",
            "你的任务不是回答问题，而是把用户问题改写成更适合检索的查询。",
            "要求：",
            "1. 保留原始意图，不要虚构新信息；",
            "2. 如果用户问题中存在代词、省略或上下文指代，可结合对话上下文补全；",
            "3. 优先产出适合在 Obsidian Markdown 笔记中检索的关键词短句；",
            "4. 保持用户问题的语言，不要强制改成英文；",
            "5. 保留重要技术术语、缩写和常见别名；为了提高检索召回，可以保留必要的中英文技术别名。",
            "6. 输出严格 JSON，格式为 {\"rewritten_query\": \"...\"}。",
        ].join("\n");
    }

    private buildQueryRewriteUserPrompt(
        originalQuery: string,
        conversationContext: string,
        scopeDescription: string,
        questionLanguage: QuestionLanguage,
    ): string {
        if (questionLanguage === "en") {
            return [
                `Current knowledge base scope: ${scopeDescription}`,
                "",
                "Recent conversation context:",
                conversationContext || "(None)",
                "",
                `Original question: ${originalQuery}`,
                "",
                "Output JSON only.",
            ].join("\n");
        }

        return [
            `当前知识库范围：${scopeDescription}`,
            "",
            "最近对话上下文：",
            conversationContext || "（无）",
            "",
            `原始问题：${originalQuery}`,
            "",
            "请只输出 JSON。",
        ].join("\n");
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

    async generateJsonAnswer(messages: LocalChatMessage[], temperature: number): Promise<string> {
        return this.chat({
            messages,
            temperature,
            format: "json",
        });
    }

    async streamMarkdownAnswer(
        messages: LocalChatMessage[],
        temperature: number,
        handlers?: StreamHandlers,
    ): Promise<string> {
        const settings: VaultCoachSettings = this.getSettings();

        try {
            if (this.shouldUseCloudChat(settings)) {
                return await this.streamCloudMarkdownAnswer(settings, messages, temperature, handlers);
            }

            return await this.streamOllamaMarkdownAnswer(settings, messages, temperature, handlers);
        } catch (error: unknown) {
            handlers?.onError?.(error);
            throw error;
        }
    }

    private async streamOllamaMarkdownAnswer(
        settings: VaultCoachSettings,
        messages: LocalChatMessage[],
        temperature: number,
        handlers?: StreamHandlers,
    ): Promise<string> {
        if (settings.chatModel.trim().length === 0) {
            throw new Error("未配置本地聊天模型。");
        }

        const targetUrl: string = this.joinUrl(settings.llmBaseUrl, "/api/chat");
        const response: Response = await this.fetchJsonStream(
            targetUrl,
            {
                model: settings.chatModel,
                messages,
                stream: true,
                options: {
                    temperature,
                },
            },
            {},
            handlers?.abortSignal,
        );

        let finalText = "";
        let pendingText = "";
        let isDone = false;

        const handleLine = (line: string): void => {
            const trimmedLine: string = line.trim();
            if (trimmedLine.length === 0) {
                return;
            }

            const parsed: OllamaStreamChunk = JSON.parse(trimmedLine) as OllamaStreamChunk;
            if (parsed.error) {
                throw new Error(parsed.error);
            }

            const token: string = parsed.message?.content ?? "";
            if (token.length > 0) {
                finalText += token;
                handlers?.onToken?.(token);
            }

            if (parsed.done) {
                isDone = true;
            }
        };

        try {
            await this.readTextStream(response, (chunk: string) => {
                pendingText += chunk;
                const lines: string[] = pendingText.split(/\r?\n/);
                pendingText = lines.pop() ?? "";

                for (let index = 0; index < lines.length; index += 1) {
                    const line: string | undefined = lines[index];
                    if (line !== undefined) {
                        handleLine(line);
                    }
                }
            }, handlers?.abortSignal);
        } catch (error: unknown) {
            if (this.isAbortError(error) && finalText.length > 0) {
                handlers?.onDone?.();
                return finalText;
            }

            throw error;
        }

        if (pendingText.trim().length > 0) {
            handleLine(pendingText);
        }

        if (!isDone && finalText.length === 0) {
            throw new Error("Invalid streaming response from Ollama");
        }

        handlers?.onDone?.();
        return finalText;
    }

    private async streamCloudMarkdownAnswer(
        settings: VaultCoachSettings,
        messages: LocalChatMessage[],
        temperature: number,
        handlers?: StreamHandlers,
    ): Promise<string> {
        const apiKey: string | null = this.getCloudApiKey();

        if (settings.cloudChatModel.trim().length === 0) {
            throw new Error("未配置云端聊天模型。");
        }

        if (!apiKey) {
            throw new Error("未配置云端模型 API key。请先在设置页选择 SecretStorage 条目。");
        }

        const targetUrl: string = this.joinUrl(
            settings.cloudBaseUrl,
            this.getCloudChatCompletionsPath(settings.cloudBaseUrl),
        );
        const response: Response = await this.fetchJsonStream(
            targetUrl,
            {
                model: settings.cloudChatModel,
                messages,
                temperature,
                stream: true,
            },
            { Authorization: `Bearer ${apiKey}` },
            handlers?.abortSignal,
        );

        let finalText = "";
        let pendingText = "";
        let isDone = false;

        const handleEventLine = (line: string): void => {
            const trimmedLine: string = line.trim();
            if (!trimmedLine.startsWith("data:")) {
                return;
            }

            const data: string = trimmedLine.slice("data:".length).trim();
            if (data.length === 0) {
                return;
            }

            if (data === "[DONE]") {
                isDone = true;
                return;
            }

            const parsed: CloudChatCompletionStreamChunk = JSON.parse(data) as CloudChatCompletionStreamChunk;
            if (parsed.error?.message) {
                throw new Error(parsed.error.message);
            }

            const token: string = parsed.choices?.[0]?.delta?.content ?? "";
            if (token.length > 0) {
                finalText += token;
                handlers?.onToken?.(token);
            }
        };

        try {
            await this.readTextStream(response, (chunk: string) => {
                pendingText += chunk;
                const lines: string[] = pendingText.split(/\r?\n/);
                pendingText = lines.pop() ?? "";

                for (let index = 0; index < lines.length; index += 1) {
                    const line: string | undefined = lines[index];
                    if (line !== undefined) {
                        handleEventLine(line);
                    }
                }
            }, handlers?.abortSignal);
        } catch (error: unknown) {
            if (this.isAbortError(error) && finalText.length > 0) {
                handlers?.onDone?.();
                return finalText;
            }

            throw error;
        }

        if (pendingText.trim().length > 0) {
            handleEventLine(pendingText);
        }

        if (!isDone && finalText.length === 0) {
            throw new Error("Invalid streaming response from cloud model");
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

        const preferredOllamaEmbeddingOptions: Record<string, number> | undefined = this.preferOllamaEmbeddingCpu
            ? { num_gpu: 0 }
            : undefined;

        try {
            return await this.embedTextsWithModernOllamaApi(settings, texts, preferredOllamaEmbeddingOptions);
        } catch (error: unknown) {
            // Windows 上 Ollama 的 GPU/CUDA 后端可能在 embedding 阶段返回 500。
            // 这种情况不应该直接放弃语义检索，先用 num_gpu: 0 强制 CPU 重试。
            if (!this.preferOllamaEmbeddingCpu && this.shouldRetryOllamaEmbeddingOnCpu(error)) {
                return this.embedTextsWithModernOllamaApiOnCpu(settings, texts, error);
            }

            if (!this.isNotFoundError(error)) {
                throw error;
            }

            console.warn("[VaultCoach] /api/embed 不可用，尝试使用旧版 /api/embeddings 接口。", error);
            try {
                return await this.embedTextsWithLegacyOllamaApi(settings, texts, preferredOllamaEmbeddingOptions);
            } catch (legacyError: unknown) {
                // 旧版 embedding 接口也可能触发同类 GPU 后端错误，因此同样保留 CPU fallback。
                if (!this.preferOllamaEmbeddingCpu && this.shouldRetryOllamaEmbeddingOnCpu(legacyError)) {
                    return this.embedTextsWithLegacyOllamaApiOnCpu(settings, texts, legacyError);
                }

                throw legacyError;
            }
        }
    }

    private async embedTextsWithModernOllamaApi(
        settings: VaultCoachSettings,
        texts: string[],
        options?: Record<string, number>,
    ): Promise<number[][]> {
        const responseText: string = await this.postJson(
            settings.llmBaseUrl,
            "/api/embed",
            {
                model: settings.embeddingModel,
                input: texts,
                truncate: true,
                ...(options ? { options } : {}),
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

    private async embedTextsWithModernOllamaApiOnCpu(
        settings: VaultCoachSettings,
        texts: string[],
        originalError: unknown,
    ): Promise<number[][]> {
        console.warn("[VaultCoach] Ollama GPU embedding 失败，尝试使用 CPU 重新生成 embedding。", originalError);
        // Ollama 会把 options 透传给底层运行器；num_gpu: 0 表示本次请求不把层卸载到 GPU。
        const embeddings: number[][] = await this.embedTextsWithModernOllamaApi(settings, texts, { num_gpu: 0 });
        this.ollamaEmbeddingCpuFallbackUsed = true;
        this.preferOllamaEmbeddingCpu = true;
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
        options?: Record<string, number>,
    ): Promise<number[][]> {
        const embeddings: number[][] = [];

        for (const text of texts) {
            const responseText: string = await this.postJson(
                settings.llmBaseUrl,
                "/api/embeddings",
                {
                    model: settings.embeddingModel,
                    prompt: text,
                    ...(options ? { options } : {}),
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

    private async embedTextsWithLegacyOllamaApiOnCpu(
        settings: VaultCoachSettings,
        texts: string[],
        originalError: unknown,
    ): Promise<number[][]> {
        console.warn("[VaultCoach] 旧版 Ollama GPU embedding 失败，尝试使用 CPU 重新生成 embedding。", originalError);
        const embeddings: number[][] = await this.embedTextsWithLegacyOllamaApi(settings, texts, { num_gpu: 0 });
        this.ollamaEmbeddingCpuFallbackUsed = true;
        this.preferOllamaEmbeddingCpu = true;
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

    private async fetchJsonStream(
        targetUrl: string,
        payload: unknown,
        headers: Record<string, string> = {},
        abortSignal?: AbortSignal,
    ): Promise<Response> {
        try {
            // requestUrl returns a buffered response; fetch is required here so the UI can receive tokens as they arrive.
            const response: Response = await window.fetch(targetUrl, {
                method: "POST",
                body: JSON.stringify(payload),
                headers: {
                    "Content-Type": "application/json",
                    ...headers,
                },
                signal: abortSignal,
            });

            if (!response.ok) {
                let responseText = "";
                try {
                    responseText = await response.text();
                } catch (readError: unknown) {
                    responseText = this.getErrorMessage(readError);
                }

                throw this.createHttpResponseError(targetUrl, response, responseText);
            }

            if (!response.body) {
                throw new Error("Streaming response body is empty.");
            }

            return response;
        } catch (error: unknown) {
            if (error instanceof ModelRequestError) {
                throw error;
            }

            if (this.isAbortError(error)) {
                throw error;
            }

            throw this.createRequestError(targetUrl, error);
        }
    }

    private async readTextStream(
        response: Response,
        onChunk: (chunk: string) => void,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        const body: ReadableStream<Uint8Array> | null = response.body;
        if (!body) {
            throw new Error("Streaming response body is empty.");
        }

        const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
        const decoder: TextDecoder = new TextDecoder();

        try {
            while (true) {
                this.throwIfAborted(abortSignal);
                const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
                if (result.done) {
                    break;
                }

                if (result.value) {
                    onChunk(decoder.decode(result.value, { stream: true }));
                }
            }

            const remainingText: string = decoder.decode();
            if (remainingText.length > 0) {
                onChunk(remainingText);
            }
        } finally {
            reader.releaseLock();
        }
    }

    private throwIfAborted(abortSignal?: AbortSignal): void {
        if (!abortSignal?.aborted) {
            return;
        }

        throw new DOMException("VaultCoach request aborted by user.", "AbortError");
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
                // 保留 400/500 响应体，才能识别 CUDA/PTX 等 Ollama 后端错误并做 CPU fallback。
                throw: false,
            });

            if (response.status >= 400) {
                throw this.createRequestUrlResponseError(targetUrl, response.status, response.text);
            }

            return response.text;
        } catch (error: unknown) {
            if (error instanceof ModelRequestError) {
                throw error;
            }

            throw this.createRequestError(targetUrl, error);
        }
    }

    private createHttpResponseError(targetUrl: string, response: Response, responseText: string): ModelRequestError {
        const normalizedResponseText: string = responseText.replace(/\s+/g, " ").trim();
        const hint: string = this.buildRequestFailureHint(targetUrl, response.status);
        const messageParts: string[] = [
            `模型请求失败：POST ${targetUrl}`,
            `HTTP ${response.status}`,
            response.statusText,
            normalizedResponseText.length > 0 ? normalizedResponseText : "",
            hint,
        ].filter((part: string) => part.length > 0);

        return new ModelRequestError(targetUrl, response.status, messageParts.join("。"));
    }

    private createRequestUrlResponseError(targetUrl: string, status: number, responseText: string): ModelRequestError {
        const normalizedResponseText: string = responseText.replace(/\s+/g, " ").trim();
        const hint: string = this.buildRequestFailureHint(targetUrl, status);
        const messageParts: string[] = [
            `模型请求失败：POST ${targetUrl}`,
            `HTTP ${status}`,
            normalizedResponseText.length > 0 ? normalizedResponseText : "",
            hint,
        ].filter((part: string) => part.length > 0);

        return new ModelRequestError(targetUrl, status, messageParts.join("。"));
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

    private shouldRetryOllamaEmbeddingOnCpu(error: unknown): boolean {
        const status: number | null = this.extractStatusCode(error);
        if (status !== null && status < 500) {
            return false;
        }

        const message: string = this.getErrorMessage(error);
        // requestUrl 在部分环境下只给出泛化的 HTTP 500，因此同时匹配状态码和常见 GPU 崩溃关键词。
        return /cuda|gpu|ptx|llama-server|unsupported toolchain|0xc0000409|server error|status 500|http 500/i.test(message);
    }

    private isAbortError(error: unknown): boolean {
        if (error instanceof DOMException) {
            return error.name === "AbortError";
        }

        if (error instanceof Error) {
            return error.name === "AbortError" || /aborted|aborterror/i.test(error.message);
        }

        return false;
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
