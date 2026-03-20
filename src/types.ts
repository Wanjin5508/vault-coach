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
 * 检索模式。
 * - keyword：只使用关键词检索
 * - vector：只使用向量检索
 * - hybrid：同时使用关键词 + 向量，并进行结果融合
 */
export type RetrievalMode = "keyword" | "vector" | "hybrid";

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


/**
 * 单条对话消息数据结构。
 * 对于 assistant 消息，sources 是可选的；
 * 对于 user 消息，通常不会携带 sources。
 */
export interface ChatMessage {
    // 消息发送者角色
    role: ChatRole;

    // 消息文本内容
    // * 第二阶段开始，这里保存 Markdown 文本而不是纯文本。
    text: string;

    // 消息创建时间戳 ms
    createdAt: number;

    // 可选：该回复对应的来源列表
    sources?: AnswerSource[];
}

/**
 * 插件设置项的数据结构。
 * 第二阶段在第一阶段的基础上加入：
 * - query rewrite
 * - 向量检索
 * - hybrid merge
 * - rerank
 * - 本地模型连接参数
 */
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

    // 向量检索返回的候选片段数
    vectorSearchTopK: number;

    // hybrid merge 后保留的候选上限
    hybridSearchTopK: number;

    // 进入 rerank 阶段的候选数量上限
    rerankTopK: number;

    // 最终拼接到 prompt 中的 chunk 数量
    contextTopK: number;

    // 在回答下方最多展示多少条来源
    answerSourceLimit: number;

    // 来源区域是否默认折叠
    collapseSourcesByDefault: boolean;

    // 默认检索模式，右侧栏启动后会使用这个模式
    defaultRetrievalMode: RetrievalMode;

    // 是否启用 query rewrite
    enableQueryRewrite: boolean;

    // 是否启用向量检索
    enableVectorRetrieval: boolean;

    // 是否启用 rerank
    enableRerank: boolean;

    // 生成回答时的 temperature
    generationTemperature: number;

    // 本地模型服务地址，例如 http://127.0.0.1:11434
    llmBaseUrl: string;

    // 用于生成最终回答和 query rewrite 的聊天模型
    chatModel: string;

    // 用于向量检索的 embedding 模型
    embeddingModel: string;

    // 可选：独立 rerank 服务地址。
    // 如果为空，则自动回退到“本地启发式 rerank”。
    rerankBaseUrl: string;

    // rerank 服务对应的模型名。
    // 只有在 rerankBaseUrl 非空时才会真正使用。
    rerankModel: string;

    // 长期记忆相关设置项
    enableLongTermMemory: boolean;
    memoryTopK: number;
    memoryMaxItems: number;
    maxConversationMessages: number;

    // 索引持久化存储与自动增量更新相关设置
    enableAutoIndexSync: boolean;
    autoIndexDebounceMs: number;
    autoIndexMaxWaitMs: number;
    autoIndexFileThreshold: number;
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
 * 向量索引中的单条向量记录。
 */
export interface ChunkEmbedding {
    chunkId: string;
    vector: number[];
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
 * 向量检索命中的结果。
 * similarity 是余弦相似度，越大表示越相关。
 */
export interface VectorSearchHit {
    chunk: IndexedChunk;
    score: number;
    similarity: number;
}

/**
 * hybrid merge 之后统一的候选结构。
 * 这样后续 rerank 与 prompt 构造就不必区分候选来自哪条通道。
 */
export interface RetrievalCandidate {
    chunk: IndexedChunk;
    score: number;
    matchedTokens: string[];
    retrievalChannels: RetrievalMode[];
    keywordScore?: number;
    vectorScore?: number;
}

/**
 * rerank 之后的候选结果。
 * retrievalScore 表示召回阶段的融合分数；
 * rerankScore 表示重排阶段的分数；
 * finalScore 是最终排序分数。
 */
export interface RerankedCandidate extends RetrievalCandidate {
    retrievalScore: number;
    rerankScore: number;
    finalScore: number;
}

/**
 * Query rewrite 的结果，便于后续在 UI 或日志中解释“模型是如何改写问题的”。
 */
export interface QueryRewriteResult {
    originalQuery: string;
    rewrittenQuery: string;
    useRewrite: boolean;
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
 * 向量索引统计信息。
 */
export interface VectorIndexStats {
    // 是否已经建立向量索引
    ready: boolean;

    // 已建立向量的 chunk 的数量
    vectorCount: number;

    // 向量维度，尚未建立时为 null
    dimension: number | null;

    // 最近一次完成的时间
    lastBuiltAt: number | null;
}

/**
 * 插件内部统一的“回答结果“结构
 * 这样后续接入 LLM 时，只需要替换 answerQuestion 的内部逻辑，而不需要修改 view 层的渲染代码
 * 第二阶段在 text + sources 的基础上增加一些调试友好的元数据。
 */
export interface AssistantAnswer {
    text: string;
    sources: AnswerSource[];
    retrievalModeUsed:RetrievalMode;
    queryRewrite: QueryRewriteResult;
}

/**
 * 发送给本地聊天模型的消息结构。
 * 这个类型与 Ollama / OpenAI 风格消息结构兼容度较高。
 */
export interface LocalChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/**
 * /v1/rerank 风格接口中常见的返回元素结构。
 */
export interface RerankResultItem {
    index: number;
    relevance_score: number;
}

/**
 * 文件级索引元数据，用于增量同步与本地持久化
 */
export interface KnowledgeBaseFileRecord {
    filePath: string;
    contentHash: string;
    chunkIds: string[];
    indexedAt: number;
}

/**
 * 一次增量同步的结果，供主插件与向量索引层联动
 */
export interface KnowledgeBaseSyncResult {
    stats: KnowledgeBaseStats;
    changedChunks: IndexedChunk[];
    removedChunkIds: string[];
    affectedFiles: string[];
}

/**
 * 持久化到磁盘的知识库快照
 */
export interface KnowledgeBaseSnapshot {
    version: number;
    settingsSignature: string;
    embeddingModel: string | null;
    stats: KnowledgeBaseStats;
    vectorStats: VectorIndexStats;
    chunks: IndexedChunk[];
    embeddings: ChunkEmbedding[];
    files: KnowledgeBaseFileRecord[];
}

/**
 * 长期记忆条目
 */
export interface MemoryItem {
    id: string;
    text: string;
    createdAt: number;
    updatedAt: number;
    lastAccessedAt: number;
}

/**
 * 记忆检索中命中结果
 */
export interface MemorySearchHit {
    item: MemoryItem;
    score:number;
    matchedTokens:string[];
}

/**
 * 运行时持久化状态
 */
export interface PersistedPluginState {
    messages: ChatMessage[];
    memories: MemoryItem[];
    lastAutoIndexAt: number | null;
}

/**
 * 流式输出回调
 */
export interface StreamHandlers {
    onToken?: (token: string) => void;
    onDone?: () => void;
    onError?: (error: unknown) => void;
}



