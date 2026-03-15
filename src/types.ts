// 用于定义项目中会复用的类型
// 目的是在后续版本迭代和新增功能时避免重复定义，并同意管理类型

/**
 * 对话消息的角色类型：
 * - user： 用户消息
 * - assistant： 助手消息
 */

export type ChatRole = "user" | "assistant"

// 单条对话消息数据结构
export interface ChatMessage {
    // 消息发送者角色
    role: ChatRole;

    // 消息文本内容
    text: string;

    // 消息创建时间戳 ms
    createdAt: number;
}

// 插件设置项的数据结构
export interface VaultCoachSettings {
    // 助手名称
    assistantName: string;

    // 初始欢迎语
    defaultGreeting: string;

    // 是否在 Obsidian 启动时自动打开右侧面板
    openInRightSidebarOnStartup: boolean;
}



