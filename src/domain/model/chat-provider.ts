import type { QueryRewriteResult } from "../retrieval/retrieval-types";
import type { LocalChatMessage } from "./model-types";

/** 与具体 UI 无关的单次流式输出回调。 */
export interface ChatStreamHandlers {
    onToken?: (token: string) => void;
    onDone?: () => void;
    onError?: (error: unknown) => void;
    abortSignal?: AbortSignal;
}

/**
 * 应用层可依赖的聊天能力端口。
 *
 * 该契约不暴露 Ollama、OpenAI 或浏览器推理细节。新增内置聊天模型时必须实现同一
 * 语义，并通过独立质量 Gate 验证，不得与 embedding provider 共用选择状态。
 */
export interface ChatProvider {
    rewriteQuery(originalQuery: string, conversationContext: string, scopeDescription: string): Promise<QueryRewriteResult>;
    extractMemoryStatements(conversationContext: string, latestUserText: string, latestAssistantText: string): Promise<string[]>;
    generateMarkdownAnswer(messages: LocalChatMessage[], temperature: number): Promise<string>;
    generateJsonAnswer(messages: LocalChatMessage[], temperature: number): Promise<string>;
    streamMarkdownAnswer(messages: LocalChatMessage[], temperature: number, handlers?: ChatStreamHandlers): Promise<string>;
}
