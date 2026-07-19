import type { AnswerSource } from "../../domain/retrieval/retrieval-types";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
    role: ChatRole;
    text: string;
    createdAt: number;
    generationDurationMs?: number;
    sources?: AnswerSource[];
}

export interface StreamHandlers {
    onToken?: (token: string) => void;
    onDone?: () => void;
    onError?: (error: unknown) => void;
    abortSignal?: AbortSignal;
}
