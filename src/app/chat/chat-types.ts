/** 聊天用例与展示层之间的稳定消息契约。 */
import type { AnswerSource } from "../../domain/retrieval/retrieval-types";

export type ChatRole = "user" | "assistant";

/** 已完成并可进入会话历史的消息。时间戳单位为 Unix 毫秒。 */
export interface ChatMessage {
    role: ChatRole;
    text: string;
    createdAt: number;
    generationDurationMs?: number;
    sources?: AnswerSource[];
}

/**
 * 单次流式回答的生命周期回调。
 * 调用方应使用 `abortSignal` 取消任务；实现必须保证终止回调不会重复触发。
 */
export interface StreamHandlers {
    onToken?: (token: string) => void;
    onDone?: () => void;
    onError?: (error: unknown) => void;
    abortSignal?: AbortSignal;
}
