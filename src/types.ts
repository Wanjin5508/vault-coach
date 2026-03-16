// 用于定义项目中会复用的类型
// 目的是在后续版本迭代和新增功能时避免重复定义，并统一管理类型

/**
 * 对话消息的角色类型：
 * - user： 用户消息
 * - assistant： 助手消息
 */

export type ChatRole = "user" | "assistant";

/**
 * * 知识库范围模式
 * - wholdVault: 扫描整个 vault 中的 md 文件
 * - specificFolder：只扫描用户指定目录下的 md 文件
 * 
 */
export type KnowledgeScopeMode = "wholeVault" | "specificFolder";

/**
 * 单条来源信息
 * 当前阶段只精确到 heading 级别，因此这里不保存 block id
 * 并且后续大概率不考虑更精确的来源定位
 */
export interface AnswerSource {
    // 来源文件在 vault 中的完整路径，例如："知识库/RAG/intro.md"
    filePath: string;

    // 当前 chunk 对应的一级定位标题；如果文件没有标题，则为 undefined
    heading?: string;

    // 直接展示给用户看的 Obsidian 链接文本，例如：[[知识库/RAG/intro.md#检索流程]]
    displayLink: string;

    // 在来源折叠区中展示的文本摘录
    excerpt: string;
}


// 单条对话消息数据结构
export interface ChatMessage {
    // 消息发送者角色
    role: ChatRole;

    // 消息文本内容
    text: string;

    // 消息创建时间戳 ms
    createdAt: number;

    // 可选：该回复对应的来源列表
    sources?: AnswerSource[];
}

// 插件设置项的数据结构
export interface VaultCoachSettings {
    // 助手名称
    assistantName: string;

    // 初始欢迎语
    defaultGreeting: string;

    // 是否在 Obsidian 启动时自动打开右侧面板
    openInRightSidebarOnStartup: boolean;

    // 知识库的范围模式，整个 vault 还是指定目录
    knowledgeScopeMode: KnowledgeScopeMode;

    // 当 knowledgeScopeMode 为指定目录时，指定目录的路径
    knowledgeFolder: string;

    // 文本 chunk 的最大字符数量
    chunkSize: number;

    // 相邻 chunk 之间保留的重叠字符数
    chunkOverlap: number;

    // 关键词检索返回的候选片段数
    keywordSearchTopK: number;

    // 在回答下方最多展示多少条来源
    answerSourceLimit: number;

    // 来源区域是否默认折叠
    collapseSourcesByDefault: boolean;
}

/**
 * 单个索引块 （chunk） 的数据结构
 * chunk 即检索的基本单位，而不是整个文档
 */
export interface IndexedChunk {
    // chunk 的唯一 id
    id: string;

    // 来源文件路径
    filePath: string;

    // 来源文件名
    fileName: string;

    // 标题路径例如 ["RAG", "混合检索"]，
    // TODO 或许可以考虑标题的层级？？
    headingPath: string[];

    // 当前 chunk 最靠近的标题 （通常使用标题路径中的最后一个标题）
    primaryHeading?: string;

    // chunk 原始文本
    text: string;

    // 预处理后的可检索文本（会把文件名、标题等信息一起拼进去）
    searchableText: string;


}

/**
 * 关键词检索命中的结果
 */
export interface KeywordSearchHit {
    // 命中的 chunk 本体
    chunk: IndexedChunk;

    // 该 chunk 的关键词得分
    score: number;

    // 在本次搜索中命中的 token 列表，比啊你后续调试语解释
    matchedTokens: string[];
}

/**
 * 知识库索引统计信息
 * 这些信息主要展示在右侧视图顶部，用来帮助用户理解当前索引状态。
 */
export interface KnowledgeBaseStats {
    // 已扫描的 md 文件数量
    fileCount: number;

    // 已生成的 chunk 数量
    chunkCount: number;

    // 上次完成索引的时间戳，如果还没有建立索引，则为 null
    lastIndexedAt: number | null;

    // 当前索引范围的文字描述，例如“整个 Vault“或者目录
    scopeDescription:string;
}

/**
 * 插件内部统一的“回答结果“结构
 * 这样后续接入 LLM 时，只需要替换 answerQuestion 的内部逻辑，而不需要修改 view 层的渲染代码
 */
export interface AssistantAnswer {
    text: string;
    sources: AnswerSource[];
}




