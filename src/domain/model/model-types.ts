/** 发送给本地或用户配置模型端点的最小聊天消息格式。 */
export interface LocalChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
