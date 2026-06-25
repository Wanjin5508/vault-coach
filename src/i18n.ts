export type SupportedLocale = "zh" | "en";

const ZH_TRANSLATIONS = {
    "command.openView": "在右侧打开 VaultCoach",
    "command.resetConversation": "重置 VaultCoach 对话",
    "command.rebuildKnowledgeIndex": "重建 Markdown 知识索引",
    "ribbon.openVaultCoach": "打开 VaultCoach",

    "notice.resetSuccess": "重置成功。",
    "notice.cannotCreateView": "无法创建新的视图。",
    "notice.index.vectorFailedWarning": "向量索引建立失败，已自动回退到关键词检索。",
    "notice.index.complete": "索引完成：{{fileCount}} 个文件，{{chunkCount}} 个片段{{vectorInfo}}。",
    "notice.index.vectorInfo": "，向量数 {{vectorCount}}",
    "notice.index.rebuildFailed": "重建索引失败，请打开开发者控制台查看错误信息。",
    "notice.index.incrementalComplete": "增量同步完成：{{count}} 个文件变更已处理。",
    "notice.index.vectorComplete": "向量索引完成：{{count}} 条向量。",
    "notice.index.vectorRebuildFailed": "向量索引重建失败，请打开开发者控制台查看错误信息。",

    "scope.wholeVault": "整个 Vault",
    "scope.folder": "目录：{{folder}}",
    "scope.folderUnset": "目录：未指定",

    "view.stat.knowledgeScope": "知识库范围",
    "view.stat.textIndex": "文本索引",
    "view.stat.vectorIndex": "向量索引",
    "view.stat.files": "文件数",
    "view.stat.chunks": "片段数",
    "view.stat.memory": "长期记忆",
    "view.stat.memoryValue": "{{count}} 条",
    "view.indexStatus.dirty": "待重建",
    "view.indexStatus.ready": "已就绪",
    "view.indexStatus.notBuilt": "尚未建立",
    "view.indexStatus.vectorReady": "已就绪（{{count}} 条）",
    "view.indexStatus.vectorFallback": "未建立 / 已回退",
    "view.retrievalModeLabel": "检索模式：",
    "view.retrieval.keyword": "关键词检索",
    "view.retrieval.vector": "向量检索",
    "view.retrieval.hybrid": "混合检索",
    "view.rebuildIndex": "重建索引",
    "view.resetConversation": "重置会话",
    "view.modeLabel": "模式",
    "view.mode.qa": "问答模式",
    "view.mode.exam": "考试模式",
    "view.inputPlaceholder": "请输入你的问题，按 Enter 发送，Shift + Enter 换行",
    "view.send": "发送",
    "view.clear": "清空",
    "view.noMessages": "暂无消息",
    "view.you": "你",
    "view.sources": "来源：{{count}}",
    "view.thinking": "思考中",
    "view.sendFailed": "发送失败：{{message}}",
    "view.sourceMarkdownFallback": "[VaultCoachView] 来源 Markdown 渲染失败，已回退到纯文本。",

    "settings.title": "VaultCoach 设置",
    "settings.general.heading": "基础",
    "settings.general.desc": "控制右侧边栏的基础显示与启动行为。",
    "settings.assistantName.name": "助手名称",
    "settings.assistantName.desc": "显示在右侧边栏头部和助手消息中的名称。",
    "settings.assistantName.placeholder": "请输入助手名称",
    "settings.defaultGreeting.name": "默认欢迎语",
    "settings.defaultGreeting.desc": "重置会话时显示的第一条助手消息。支持 Markdown。",
    "settings.defaultGreeting.placeholder": "请输入默认欢迎语",
    "settings.openOnStartup.name": "启动时自动打开右侧边栏",
    "settings.defaultRetrievalMode.name": "默认检索模式",
    "settings.defaultRetrievalMode.desc": "右侧边栏打开时默认使用的召回通道。",
    "settings.collapseSources.name": "来源默认折叠",
    "settings.collapseSources.desc": "开启后，回答下方的来源区域默认折叠显示。",

    "settings.knowledge.heading": "知识库",
    "settings.knowledge.desc": "控制 Markdown 文件的扫描范围与 chunk 策略。修改后建议重建索引。",
    "settings.scope.name": "扫描范围",
    "settings.scope.wholeVault": "整个 vault",
    "settings.scope.specificFolder": "指定目录",
    "settings.folder.name": "指定目录",
    "settings.folder.desc": "仅在扫描范围为指定目录时生效。",
    "settings.folder.placeholder": "请输入目录路径",
    "settings.chunkSize.name": "Chunk 大小",
    "settings.chunkSize.desc": "每个片段允许的最大字符数。数值越大，上下文更完整，但 embedding 与生成开销也会更大。",
    "settings.chunkOverlap.name": "Chunk 重叠",
    "settings.chunkOverlap.desc": "相邻 chunk 之间保留的字符数，用来减少切块边界损失。",
    "settings.autoSync.name": "启用自动增量同步",
    "settings.autoSync.desc": "监听 vault 中 Markdown 文件变化，在阈值或时间窗口达到后自动同步索引。",
    "settings.autoSyncThreshold.name": "自动同步文件阈值",
    "settings.autoSyncThreshold.desc": "累计发生改动的 Markdown 文件数达到该阈值时，立即触发一次增量同步。",
    "settings.autoSyncDebounce.name": "自动同步防抖时间（毫秒）",
    "settings.autoSyncDebounce.desc": "最后一次文件变化后等待这么久再同步，避免频繁重建。",
    "settings.autoSyncMaxWait.name": "自动同步最大等待时间（毫秒）",
    "settings.autoSyncMaxWait.desc": "即使文件变化不断发生，最长也会在该时间后强制执行一次同步。",

    "settings.model.heading": "模型",
    "settings.model.desc": "分别选择回答生成、向量检索和可选 rerank 使用的模型服务。只有当前选中的服务会被调用。",
    "settings.model.chatProvider.name": "回答模型服务",
    "settings.model.chatProvider.desc": "用于 query rewrite、最终回答生成和长期记忆抽取。",
    "settings.model.embeddingProvider.name": "Embedding 模型服务",
    "settings.model.embeddingProvider.desc": "用于向量检索。切换服务或模型后需要重建索引。",
    "settings.model.localOllama": "本地 Ollama",
    "settings.model.openAICompatible": "OpenAI 兼容",
    "settings.localChatModel.name": "本地聊天模型",
    "settings.localChatModel.desc": "用于 query rewrite、最终回答生成和长期记忆抽取。",
    "settings.cloudChatBaseUrl.name": "云端聊天服务地址",
    "settings.cloudChatBaseUrl.desc": "例如：https://api.deepseek.com",
    "settings.cloudChatModel.name": "云端聊天模型",
    "settings.cloudChatModel.desc": "用于 query rewrite、最终回答生成和长期记忆抽取。",
    "settings.localEmbeddingModel.name": "本地 embedding 模型",
    "settings.localEmbeddingModel.desc": "用于本地向量检索。修改后需要重建索引。",
    "settings.cloudEmbeddingBaseUrl.name": "云端 embedding 服务地址",
    "settings.cloudEmbeddingBaseUrl.desc": "例如：https://api.openai.com/v1 或其他兼容 /embeddings 的服务地址。",
    "settings.cloudEmbeddingModel.name": "云端 embedding 模型",
    "settings.cloudEmbeddingModel.desc": "用于网络向量检索。修改后需要重建索引。",
    "settings.localServiceBaseUrl.name": "本地推理服务地址",
    "settings.localServiceBaseUrl.desc": "例如：http://127.0.0.1:11434。用于当前选择的本地聊天或 embedding 模型。",
    "settings.cloudApiKey.name": "云端密钥",
    "settings.cloudApiKey.desc": "保存到 Obsidian secret storage。网络模型会向用户配置的远程 API 发送问题、知识片段、检索上下文和少量对话上下文。",
    "settings.rerankBaseUrl.name": "独立 rerank 服务地址",
    "settings.rerankBaseUrl.desc": "可选，例如：http://127.0.0.1:11435。留空时自动回退到本地启发式 rerank。",
    "settings.rerankBaseUrl.placeholder": "留空表示不使用独立 rerank 服务",
    "settings.rerankModel.name": "Rerank 模型",
    "settings.rerankModel.desc": "只有在配置了独立 rerank 服务地址后才会使用。",
    "settings.rerankModel.placeholder": "例如：bge-reranker-v2-m3",

    "settings.memory.heading": "长期记忆",
    "settings.memory.enable.name": "启用长期记忆",
    "settings.memory.enable.desc": "在每轮问答结束后抽取可长期保留的事实，并在后续相关问题中注入。",
    "settings.memory.topK.name": "记忆注入数量",
    "settings.memory.topK.desc": "每次回答最多注入多少条与当前问题最相关的长期记忆。",
    "settings.memory.maxItems.name": "最大记忆条数",
    "settings.memory.maxItems.desc": "超过上限后会优先保留最近更新或最近命中的记忆。",
    "settings.memory.maxMessages.name": "最大持久化消息数",
    "settings.memory.maxMessages.desc": "对话历史会持久化到本地，但只保留最近若干条，避免状态文件无限膨胀。",

    "settings.advanced.heading": "高级 RAG",
    "settings.advanced.desc": "控制 query rewrite、向量检索、hybrid merge 与 rerank 的行为。",
    "settings.queryRewrite.name": "启用 query rewrite",
    "settings.queryRewrite.desc": "开启后，插件会先把用户问题改写为更适合检索的查询。",
    "settings.vectorRetrieval.name": "启用向量检索",
    "settings.vectorRetrieval.desc": "开启后，重建索引时会为 chunk 生成 embedding，并支持 vector / hybrid 模式。",
    "settings.rerank.enable.name": "启用 rerank",
    "settings.rerank.enable.desc": "开启后，召回候选会进入重排阶段；如果未配置独立 rerank 服务，将自动回退到本地启发式重排。",
    "settings.keywordTopK.name": "关键词 top k",
    "settings.keywordTopK.desc": "关键词召回保留的候选数量。",
    "settings.vectorTopK.name": "向量 top k",
    "settings.vectorTopK.desc": "向量召回保留的候选数量。",
    "settings.hybridTopK.name": "Hybrid 候选上限",
    "settings.hybridTopK.desc": "关键词 + 向量融合之后保留的候选数量上限。",
    "settings.rerankTopK.name": "Rerank top k",
    "settings.rerankTopK.desc": "进入 rerank 阶段的候选数量上限。",
    "settings.contextTopK.name": "上下文 chunks 数",
    "settings.contextTopK.desc": "最终真正注入到 prompt 中的 chunk 数量。不是越大越好，过多反而会稀释重点。",
    "settings.sourceLimit.name": "来源数量上限",
    "settings.sourceLimit.desc": "每条回答下方最多展示多少条来源。",
    "settings.temperature.name": "生成温度",
    "settings.temperature.desc": "控制回答的发散程度。RAG 场景通常建议保持较低值。",
} as const;

export type TranslationKey = keyof typeof ZH_TRANSLATIONS;

const EN_TRANSLATIONS: Record<TranslationKey, string> = {
    "command.openView": "Open VaultCoach in the right sidebar",
    "command.resetConversation": "Reset VaultCoach conversation",
    "command.rebuildKnowledgeIndex": "Rebuild Markdown knowledge index",
    "ribbon.openVaultCoach": "Open VaultCoach",

    "notice.resetSuccess": "Reset complete.",
    "notice.cannotCreateView": "Cannot create a new view.",
    "notice.index.vectorFailedWarning": "Vector index build failed. VaultCoach has fallen back to keyword search.",
    "notice.index.complete": "Index complete: {{fileCount}} files, {{chunkCount}} chunks{{vectorInfo}}.",
    "notice.index.vectorInfo": ", {{vectorCount}} vectors",
    "notice.index.rebuildFailed": "Failed to rebuild the index. Open the developer console for details.",
    "notice.index.incrementalComplete": "Incremental sync complete: {{count}} changed files processed.",
    "notice.index.vectorComplete": "Vector index complete: {{count}} vectors.",
    "notice.index.vectorRebuildFailed": "Failed to rebuild the vector index. Open the developer console for details.",

    "scope.wholeVault": "Entire vault",
    "scope.folder": "Folder: {{folder}}",
    "scope.folderUnset": "Folder: not set",

    "view.stat.knowledgeScope": "Knowledge base",
    "view.stat.textIndex": "Text index",
    "view.stat.vectorIndex": "Vector index",
    "view.stat.files": "Files",
    "view.stat.chunks": "Chunks",
    "view.stat.memory": "Memory",
    "view.stat.memoryValue": "{{count}} items",
    "view.indexStatus.dirty": "Needs rebuild",
    "view.indexStatus.ready": "Ready",
    "view.indexStatus.notBuilt": "Not built",
    "view.indexStatus.vectorReady": "Ready ({{count}} vectors)",
    "view.indexStatus.vectorFallback": "Not built / fallback active",
    "view.retrievalModeLabel": "Retrieval mode:",
    "view.retrieval.keyword": "Keyword search",
    "view.retrieval.vector": "Vector search",
    "view.retrieval.hybrid": "Hybrid search",
    "view.rebuildIndex": "Rebuild index",
    "view.resetConversation": "Reset conversation",
    "view.modeLabel": "Mode",
    "view.mode.qa": "Q&A",
    "view.mode.exam": "Exam",
    "view.inputPlaceholder": "Ask a question. Press Enter to send, Shift + Enter for a new line",
    "view.send": "Send",
    "view.clear": "Clear",
    "view.noMessages": "No messages yet",
    "view.you": "You",
    "view.sources": "Sources: {{count}}",
    "view.thinking": "Thinking",
    "view.sendFailed": "Send failed: {{message}}",
    "view.sourceMarkdownFallback": "[VaultCoachView] Source Markdown render failed. Falling back to plain text.",

    "settings.title": "VaultCoach settings",
    "settings.general.heading": "General",
    "settings.general.desc": "Control sidebar display and startup behavior.",
    "settings.assistantName.name": "Assistant name",
    "settings.assistantName.desc": "Shown in the sidebar header and assistant messages.",
    "settings.assistantName.placeholder": "Enter assistant name",
    "settings.defaultGreeting.name": "Default greeting",
    "settings.defaultGreeting.desc": "The first assistant message shown after resetting the conversation. Supports Markdown.",
    "settings.defaultGreeting.placeholder": "Enter the default greeting",
    "settings.openOnStartup.name": "Open right sidebar on startup",
    "settings.defaultRetrievalMode.name": "Default retrieval mode",
    "settings.defaultRetrievalMode.desc": "The retrieval channel used when the sidebar opens.",
    "settings.collapseSources.name": "Collapse sources by default",
    "settings.collapseSources.desc": "When enabled, the sources under each answer start collapsed.",

    "settings.knowledge.heading": "Knowledge base",
    "settings.knowledge.desc": "Control Markdown scan scope and chunking. Rebuild the index after changes.",
    "settings.scope.name": "Scan scope",
    "settings.scope.wholeVault": "Entire vault",
    "settings.scope.specificFolder": "Specific folder",
    "settings.folder.name": "Specific folder",
    "settings.folder.desc": "Only used when scan scope is set to a specific folder.",
    "settings.folder.placeholder": "Enter folder path",
    "settings.chunkSize.name": "Chunk size",
    "settings.chunkSize.desc": "Maximum characters per chunk. Larger chunks preserve more context but increase embedding and generation cost.",
    "settings.chunkOverlap.name": "Chunk overlap",
    "settings.chunkOverlap.desc": "Characters preserved between adjacent chunks to reduce boundary loss.",
    "settings.autoSync.name": "Enable automatic incremental sync",
    "settings.autoSync.desc": "Watch Markdown file changes in the vault and sync the index after the threshold or time window is reached.",
    "settings.autoSyncThreshold.name": "Auto-sync file threshold",
    "settings.autoSyncThreshold.desc": "Trigger incremental sync immediately when this many changed Markdown files are queued.",
    "settings.autoSyncDebounce.name": "Auto-sync debounce time (ms)",
    "settings.autoSyncDebounce.desc": "Wait this long after the latest file change before syncing to avoid frequent rebuilds.",
    "settings.autoSyncMaxWait.name": "Auto-sync maximum wait (ms)",
    "settings.autoSyncMaxWait.desc": "Force a sync after this time even if file changes keep arriving.",

    "settings.model.heading": "Models",
    "settings.model.desc": "Choose model services for answer generation, vector retrieval, and optional rerank. Only the selected services are called.",
    "settings.model.chatProvider.name": "Answer model service",
    "settings.model.chatProvider.desc": "Used for query rewrite, final answer generation, and long-term memory extraction.",
    "settings.model.embeddingProvider.name": "Embedding model service",
    "settings.model.embeddingProvider.desc": "Used for vector retrieval. Rebuild the index after changing the service or model.",
    "settings.model.localOllama": "Local Ollama",
    "settings.model.openAICompatible": "OpenAI compatible",
    "settings.localChatModel.name": "Local chat model",
    "settings.localChatModel.desc": "Used for query rewrite, final answer generation, and long-term memory extraction.",
    "settings.cloudChatBaseUrl.name": "Cloud chat service URL",
    "settings.cloudChatBaseUrl.desc": "Example: https://api.deepseek.com",
    "settings.cloudChatModel.name": "Cloud chat model",
    "settings.cloudChatModel.desc": "Used for query rewrite, final answer generation, and long-term memory extraction.",
    "settings.localEmbeddingModel.name": "Local embedding model",
    "settings.localEmbeddingModel.desc": "Used for local vector retrieval. Rebuild the index after changing it.",
    "settings.cloudEmbeddingBaseUrl.name": "Cloud embedding service URL",
    "settings.cloudEmbeddingBaseUrl.desc": "Example: https://api.openai.com/v1 or another service compatible with /embeddings.",
    "settings.cloudEmbeddingModel.name": "Cloud embedding model",
    "settings.cloudEmbeddingModel.desc": "Used for remote vector retrieval. Rebuild the index after changing it.",
    "settings.localServiceBaseUrl.name": "Local inference service URL",
    "settings.localServiceBaseUrl.desc": "Example: http://127.0.0.1:11434. Used by the selected local chat or embedding model.",
    "settings.cloudApiKey.name": "Cloud API key",
    "settings.cloudApiKey.desc": "Stored in Obsidian secret storage. Remote models receive the user's question, knowledge chunks, retrieval context, and a small amount of conversation context.",
    "settings.rerankBaseUrl.name": "Dedicated rerank service URL",
    "settings.rerankBaseUrl.desc": "Optional. Example: http://127.0.0.1:11435. When empty, VaultCoach falls back to local heuristic rerank.",
    "settings.rerankBaseUrl.placeholder": "Leave empty to skip a dedicated rerank service",
    "settings.rerankModel.name": "Rerank model",
    "settings.rerankModel.desc": "Only used when a dedicated rerank service URL is configured.",
    "settings.rerankModel.placeholder": "Example: bge-reranker-v2-m3",

    "settings.memory.heading": "Long-term memory",
    "settings.memory.enable.name": "Enable long-term memory",
    "settings.memory.enable.desc": "Extract durable facts after each Q&A turn and inject relevant memories into future answers.",
    "settings.memory.topK.name": "Memory injection count",
    "settings.memory.topK.desc": "Maximum number of long-term memories injected into each answer.",
    "settings.memory.maxItems.name": "Maximum memory items",
    "settings.memory.maxItems.desc": "When the limit is exceeded, recently updated or recently used memories are kept first.",
    "settings.memory.maxMessages.name": "Maximum persisted messages",
    "settings.memory.maxMessages.desc": "Conversation history is persisted locally, but only the most recent messages are kept to avoid unbounded state growth.",

    "settings.advanced.heading": "Advanced RAG",
    "settings.advanced.desc": "Control query rewrite, vector retrieval, hybrid merge, and rerank behavior.",
    "settings.queryRewrite.name": "Enable query rewrite",
    "settings.queryRewrite.desc": "Rewrite the user's question into a query that is better suited for retrieval.",
    "settings.vectorRetrieval.name": "Enable vector retrieval",
    "settings.vectorRetrieval.desc": "Generate embeddings for chunks during index rebuilds and enable vector / hybrid modes.",
    "settings.rerank.enable.name": "Enable rerank",
    "settings.rerank.enable.desc": "Run recalled candidates through rerank. If no dedicated rerank service is configured, VaultCoach uses local heuristic rerank.",
    "settings.keywordTopK.name": "Keyword top k",
    "settings.keywordTopK.desc": "Number of candidates kept from keyword recall.",
    "settings.vectorTopK.name": "Vector top k",
    "settings.vectorTopK.desc": "Number of candidates kept from vector recall.",
    "settings.hybridTopK.name": "Hybrid candidate limit",
    "settings.hybridTopK.desc": "Maximum candidates kept after merging keyword and vector results.",
    "settings.rerankTopK.name": "Rerank top k",
    "settings.rerankTopK.desc": "Maximum number of candidates entering rerank.",
    "settings.contextTopK.name": "Context chunks",
    "settings.contextTopK.desc": "Number of chunks actually injected into the prompt. More is not always better because too much context can dilute relevance.",
    "settings.sourceLimit.name": "Source limit",
    "settings.sourceLimit.desc": "Maximum sources shown below each answer.",
    "settings.temperature.name": "Generation temperature",
    "settings.temperature.desc": "Controls how varied answers can be. Lower values are usually better for RAG.",
};

const TRANSLATIONS: Record<SupportedLocale, Record<TranslationKey, string>> = {
    zh: ZH_TRANSLATIONS,
    en: EN_TRANSLATIONS,
};

const DEFAULT_GREETINGS: Record<SupportedLocale, string> = {
    zh: [
        "# 你好，我是 VaultCoach",
        "",
    ].join("\n"),
    en: [
        "# Hi, I'm VaultCoach",
        "",
    ].join("\n"),
};

export function detectSystemLocale(): SupportedLocale {
    const languages: string[] = [];

    if (typeof navigator !== "undefined") {
        for (const language of navigator.languages) {
            if (language.trim().length > 0) {
                languages.push(language);
            }
        }

        if (navigator.language.trim().length > 0) {
            languages.push(navigator.language);
        }
    }

    return languages.some((language: string) => isChineseLocale(language)) ? "zh" : "en";
}

export function translate(
    key: TranslationKey,
    replacements: Record<string, string | number> = {},
    locale: SupportedLocale = detectSystemLocale(),
): string {
    const template: string = TRANSLATIONS[locale][key] ?? ZH_TRANSLATIONS[key];
    let result: string = template;

    for (const replacementKey of Object.keys(replacements)) {
        const value: string | number | undefined = replacements[replacementKey];
        if (value === undefined) {
            continue;
        }

        result = result.replace(
            new RegExp(`{{\\s*${escapeRegExp(replacementKey)}\\s*}}`, "g"),
            String(value),
        );
    }

    return result;
}

export function getDefaultGreeting(locale: SupportedLocale = detectSystemLocale()): string {
    return DEFAULT_GREETINGS[locale];
}

export function isBuiltInDefaultGreeting(value: string): boolean {
    const normalizedValue: string = normalizeGreeting(value);
    return normalizeGreeting(DEFAULT_GREETINGS.zh) === normalizedValue
        || normalizeGreeting(DEFAULT_GREETINGS.en) === normalizedValue;
}

function isChineseLocale(language: string): boolean {
    const normalizedLanguage: string = language.toLowerCase().replace("_", "-");
    return normalizedLanguage === "zh" || normalizedLanguage.startsWith("zh-");
}

function normalizeGreeting(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
