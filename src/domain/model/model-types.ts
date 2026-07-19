export interface LocalChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
