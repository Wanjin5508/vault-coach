import { getLanguage } from "obsidian";

/**
 * 国际化文案模块。
 *
 * 统一维护中英文 UI 文案、通知文案和默认欢迎语。业务代码应通过 translate
 * 或 VaultCoach/VaultCoachView 内部的 t 方法取文案，避免直接硬编码用户可见文本。
 */

/**
 * 当前支持的语言。
 */
export type SupportedLocale = "zh" | "en";

const ZH_TRANSLATIONS = {
    "command.openView": "在右侧打开 VaultCoach",
    "command.resetConversation": "重置 VaultCoach 对话",
    "command.rebuildKnowledgeIndex": "重建知识索引",
    "command.stopKnowledgeIndex": "停止构建知识索引",
    "command.clearKnowledgeIndex": "清除知识索引",
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
    "notice.index.ollamaConnectionFailed": "无法连接本地 Ollama 服务，向量索引已回退到关键词检索。请确认 Ollama 已启动，本地推理服务地址为 http://127.0.0.1:11434，并已拉取 embedding 模型。",
    "notice.index.ollamaEmbeddingCpuFallback": "检测到 Ollama GPU 无法完成 embedding，已自动改用 CPU 生成向量。CPU 会更慢；建议检查 Windows NVIDIA 驱动、CUDA 与 Ollama 配置。若本地 LLM 仍报错，建议在模型设置中改用云端 LLM。",
    "notice.index.alreadyBuilding": "索引正在构建中。",
    "notice.index.stopRequested": "已请求停止索引构建。",
    "notice.index.stopped": "已停止索引构建。",
    "notice.index.noActiveBuild": "当前没有正在构建的索引。",
    "notice.index.clearWhileBusy": "索引正在构建中。请先停止构建后再清除索引。",
    "notice.index.cleared": "已清除知识索引。",

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
    "view.indexStatus.building": "构建中",
    "view.indexStatus.ready": "已就绪",
    "view.indexStatus.notBuilt": "尚未建立",
    "view.indexStatus.vectorReady": "已就绪（{{count}} 条）",
    "view.indexStatus.vectorDisabled": "已关闭",
    "view.indexStatus.vectorFallback": "未建立 / 已回退",
    "view.indexBusy.rebuilding": "正在重建知识索引...",
    "view.indexBusy.syncing": "正在同步知识索引...",
    "view.indexBusy.vector": "正在构建向量索引...",
    "view.indexBusy.generic": "正在构建索引...",
    "view.retrievalModeLabel": "检索模式：",
    "view.retrieval.keyword": "关键词检索",
    "view.retrieval.vector": "向量检索",
    "view.retrieval.hybrid": "混合检索",
    "view.rebuildIndex": "重建索引",
    "view.rebuildIndexBusy": "构建中...",
    "view.stopIndexBuild": "停止索引",
    "view.clearIndex": "清除索引",
    "view.resetConversation": "重置会话",
    "view.modeLabel": "模式",
    "view.mode.qa": "问答模式",
    "view.mode.exam": "考试模式",
    "view.inputPlaceholder": "请输入你的问题，按 Enter 发送，Shift + Enter 换行",
    "view.send": "发送",
    "view.clear": "清空",
    "view.stopGenerating": "停止输出",
    "view.generationStopped": "已停止生成。",
    "view.modelStatus.chat": "推理：{{model}}",
    "view.modelStatus.embedding": "词嵌入：{{model}}",
    "view.modelUnset": "未配置",
    "view.noMessages": "暂无消息",
    "view.you": "你",
    "view.sources": "来源：{{count}}",
    "view.source.pdfPage": "第 {{page}} 页",
    "view.source.pdfPages": "第 {{start}}-{{end}} 页",
    "view.thinking": "思考中",
    "view.copyMessage": "复制消息",
    "view.copyMessageSuccess": "已复制消息内容。",
    "view.copyMessageFailed": "复制失败：{{message}}",
    "view.sendFailed": "发送失败：{{message}}",
    "view.sourceMarkdownFallback": "[VaultCoachView] 来源 Markdown 渲染失败，已回退到纯文本。",

    "exam.defaultTitle": "VaultCoach 测试",
    "exam.unanswered": "（未作答）",
    "exam.scope.fullCurrentKnowledgeBase": "当前完整知识库",
    "exam.setup.title": "创建一次测试",
    "exam.setup.desc": "选择测试范围和题目数量后，VaultCoach 会基于当前知识库生成题目。提交评分后，测试记录会默认保存到隐藏历史目录。",
    "exam.scope.title": "测试范围",
    "exam.scope.all": "完整知识库",
    "exam.scope.folders": "选择目录",
    "exam.scope.meta": "{{fileCount}} 个文件 · {{chunkCount}} 个片段",
    "exam.scope.noFolders": "当前知识库范围内还没有可选择的子目录。",
    "exam.files.title": "考试文件",
    "exam.files.summary": "当前范围包含 {{total}} 个文件 · 已排除 {{excluded}} 个 · 实际参与 {{eligible}} 个",
    "exam.files.capacity": "当前有效内容预计可支持 {{min}}–{{max}} 道题",
    "exam.files.capacityEmpty": "当前有效内容不足，无法生成测试题",
    "exam.files.manage": "管理文件",
    "exam.files.hideManager": "收起文件",
    "exam.files.noEligible": "当前范围没有可用于考试的文件。请减少手动排除，或检查 frontmatter 与设置页排除规则。",
    "exam.files.search": "搜索文件路径",
    "exam.files.includeAll": "全选",
    "exam.files.excludeAll": "全部排除",
    "exam.files.reset": "恢复默认",
    "exam.files.noMatches": "没有匹配的文件。",
    "exam.files.rootFolder": "Vault 根目录",
    "exam.files.chunkCount": "{{count}} 个片段",
    "exam.files.permanentExcluded": "规则排除",
    "exam.files.permanentReason": "规则排除：{{reason}}",
    "exam.files.manualExcluded": "手动排除",
    "exam.questionCount": "题目数量",
    "exam.analyze": "分析考试范围",
    "exam.reanalyze": "重新分析考试内容",
    "exam.start": "开始生成测试",
    "exam.cancel": "取消",
    "exam.cancelling": "正在取消",
    "exam.generating": "正在基于知识库生成测试题",
    "exam.evaluating": "正在评分",
    "exam.progress.resolvingScope": "正在收集考试文件",
    "exam.progress.ruleFiltering": "正在应用目录、文件和规则过滤",
    "exam.progress.semanticFiltering": "正在分析内容",
    "exam.progress.semanticFilteringCount": "正在分析内容 {{current}} / {{total}}",
    "exam.progress.planning": "正在规划知识点",
    "exam.progress.generating": "正在生成题目",
    "exam.progress.generatingCount": "正在生成题目 {{current}} / {{total}}",
    "exam.progress.validating": "正在检查题目质量",
    "exam.progress.repairing": "正在修复模型输出",
    "exam.progress.completed": "已完成",
    "exam.analysis.running": "正在分析考试范围",
    "exam.analysis.complete": "范围分析完成",
    "exam.analysis.totalFiles": "总文件",
    "exam.analysis.ruleExcluded": "规则排除",
    "exam.analysis.semanticExcluded": "智能排除",
    "exam.analysis.partial": "部分可用",
    "exam.analysis.included": "完全可用",
    "exam.analysis.forceIncluded": "强制包含",
    "exam.analysis.capacity": "预计题量",
    "exam.analysis.cache": "缓存命中",
    "exam.analysis.details": "查看筛选详情",
    "exam.analysis.exclude": "手动排除",
    "exam.analysis.forceInclude": "强制包含",
    "exam.analysis.failedTitle": "智能内容筛选失败",
    "exam.analysis.failedDesc": "已完成目录和文件规则过滤。你可以重试智能筛选，或仅使用人工选择的范围继续生成。",
    "exam.analysis.retry": "重试智能筛选",
    "exam.analysis.continueManual": "仅使用人工范围继续",
    "exam.taking.title": "作答",
    "exam.taking.desc": "回答完成后提交评分。评分完成后会默认保存到隐藏历史目录，也可以在结果页手动导出。",
    "exam.answerPlaceholder": "在这里输入你的答案",
    "exam.submit": "提交评分",
    "exam.delete": "删除测试",
    "exam.save": "保存测试结果",
    "exam.history": "考试历史",
    "exam.newTest": "创建新测试",
    "exam.review.title": "测试结果",
    "exam.score": "得分",
    "exam.overallFeedback": "总体反馈",
    "exam.userAnswer": "用户答案",
    "exam.referenceAnswer": "参考答案",
    "exam.rubric": "评分标准",
    "exam.feedback": "反馈",
    "exam.improvement": "改进建议",
    "exam.sourcePaths": "来源路径",
    "exam.savedPath": "历史记录：{{path}}",
    "exam.export.title": "手动导出",
    "exam.export.desc": "默认历史记录保存在隐藏目录中。需要在笔记列表中看到结果时，可以导出一份到指定目录。",
    "exam.export.placeholder": "输入 vault 内目录路径，例如：考试记录",
    "exam.export.button": "导出到目录",
    "exam.history.title": "考试历史",
    "exam.history.back": "返回",
    "exam.history.empty": "暂无考试历史。",
    "exam.history.loading": "正在读取考试历史",
    "exam.history.select": "选择一条历史记录查看详情。",
    "exam.history.delete": "删除",
    "exam.history.unknownDate": "未知时间",
    "exam.history.noScore": "未评分",
    "exam.emptyKnowledge.title": "当前没有可用的知识库片段",
    "exam.emptyKnowledge.desc": "请先重建索引，或检查设置页中的知识库范围。",
    "exam.notice.noChunks": "当前考试范围内没有可用的知识库片段。",
    "exam.notice.cancelled": "已取消考试生成。",
    "exam.notice.analysisFailed": "智能筛选失败：{{message}}",
    "exam.notice.createFailed": "创建测试失败：{{message}}",
    "exam.notice.evaluateFailed": "评分失败：{{message}}",
    "exam.notice.saveFailed": "保存测试失败：{{message}}",
    "exam.notice.exported": "测试结果已导出到：{{path}}",
    "exam.notice.exportFailed": "导出测试失败：{{message}}",
    "exam.notice.deleteFailed": "删除测试失败：{{message}}",
    "exam.notice.historyFailed": "读取考试历史失败：{{message}}",
    "exam.notice.invalidHistoryPath": "无效的考试历史路径。",
    "exam.notice.exportPathIsFile": "导出目录路径已经是一个文件。",
    "exam.notice.openSourceFailed": "打开来源失败：{{message}}",
    "exam.notice.saved": "测试结果已保存。",
    "exam.notice.deleted": "测试已删除。",
    "exam.notice.questionCountReduced": "请求生成 {{requested}} 道题，其中 {{actual}} 道通过范围与质量检查。本次测试将使用 {{actual}} 道题。",
    "exam.markdown.id": "测试 ID",
    "exam.markdown.createdAt": "创建时间",
    "exam.markdown.scope": "测试范围",
    "exam.markdown.questionCount": "题目数量",
    "exam.markdown.score": "得分",
    "exam.markdown.overallFeedback": "总体反馈",
    "exam.markdown.questions": "题目与答案",
    "exam.markdown.userAnswer": "用户答案",
    "exam.markdown.referenceAnswer": "参考答案",
    "exam.markdown.rubric": "评分标准",
    "exam.markdown.evaluation": "评分反馈",
    "exam.markdown.feedback": "反馈",
    "exam.markdown.improvement": "改进建议",
    "exam.markdown.sources": "来源",

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
    "settings.knowledge.desc": "控制知识库文件的扫描范围、文件类型与 chunk 策略。修改后建议重建索引。",
    "settings.scope.name": "扫描范围",
    "settings.scope.wholeVault": "整个 vault",
    "settings.scope.specificFolder": "指定目录",
    "settings.folder.name": "指定目录",
    "settings.folder.desc": "仅在扫描范围为指定目录时生效。",
    "settings.folder.placeholder": "请输入目录路径",
    "settings.markdownIndexing.name": "索引 Markdown 文件",
    "settings.markdownIndexing.desc": "开启后，VaultCoach 会扫描知识库范围内的 Markdown 笔记。",
    "settings.pdfIndexing.name": "索引文本型 PDF",
    "settings.pdfIndexing.desc": "关闭时不会读取 PDF。开启后，VaultCoach 会提取 PDF 文本层并用于问答、检索和考试；云端 embedding 会收到提取后的 PDF 文本。",
    "settings.maxPdfFileSize.name": "PDF 文件大小上限（MB）",
    "settings.maxPdfFileSize.desc": "超过上限的 PDF 会跳过，避免索引耗时和 embedding 成本失控。",
    "settings.maxPdfPageCount.name": "PDF 页数上限",
    "settings.maxPdfPageCount.desc": "超过上限的 PDF 会跳过。扫描型 PDF 暂不会自动 OCR。",
    "settings.chunkSize.name": "Chunk 大小",
    "settings.chunkSize.desc": "每个片段允许的最大字符数。数值越大，上下文更完整，但 embedding 与生成开销也会更大。",
    "settings.chunkOverlap.name": "Chunk 重叠",
    "settings.chunkOverlap.desc": "相邻 chunk 之间保留的字符数，用来减少切块边界损失。",
    "settings.autoSync.name": "启用自动增量同步",
    "settings.autoSync.desc": "监听 vault 中已启用知识文件的变化，在阈值或时间窗口达到后自动同步索引。",
    "settings.autoSyncThreshold.name": "自动同步文件阈值",
    "settings.autoSyncThreshold.desc": "累计发生改动的知识文件数达到该阈值时，立即触发一次增量同步。",
    "settings.autoSyncDebounce.name": "自动同步防抖时间（毫秒）",
    "settings.autoSyncDebounce.desc": "最后一次文件变化后等待这么久再同步，避免频繁重建。",
    "settings.autoSyncMaxWait.name": "自动同步最大等待时间（毫秒）",
    "settings.autoSyncMaxWait.desc": "即使文件变化不断发生，最长也会在该时间后强制执行一次同步。",
    "settings.exam.heading": "考试模式",
    "settings.exam.desc": "控制考试出题范围、长期排除规则和内容质量筛选。普通问答不受这些设置影响。",
    "settings.examExcludePaths.name": "考试模式排除路径",
    "settings.examExcludePaths.desc": "仅影响考试模式。每行一个 vault 相对路径或简单 glob，例如 TODO/**、Archive/**、**/*.draft.md。",
    "settings.examExcludePaths.placeholder": "TODO/**\nDaily Notes/**\nArchive/**\n**/*.draft.md",
    "settings.examSmartFiltering.name": "智能排除不适合出题的内容",
    "settings.examSmartFiltering.desc": "开启后，考试模式会用规则和已配置聊天模型识别适合考试的文件与章节，并复用本地画像缓存。普通问答不受影响。",

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
    "settings.cloudApiKey.desc": "保存到 Obsidian secret storage。网络模型会向用户配置的远程 API 发送问题、知识片段、检索上下文、考试筛选/出题/审查片段和少量对话上下文。",
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
    "command.rebuildKnowledgeIndex": "Rebuild knowledge index",
    "command.stopKnowledgeIndex": "Stop building knowledge index",
    "command.clearKnowledgeIndex": "Clear knowledge index",
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
    "notice.index.ollamaConnectionFailed": "Cannot connect to local Ollama, so VaultCoach has fallen back to keyword search. Make sure Ollama is running, the local service URL is http://127.0.0.1:11434, and the embedding model has been pulled.",
    "notice.index.ollamaEmbeddingCpuFallback": "Ollama GPU embedding failed, so VaultCoach automatically retried embeddings on CPU. CPU mode is slower; check your Windows NVIDIA driver, CUDA, and Ollama setup. If local LLM calls still fail, switch the answer model to a cloud LLM in settings.",
    "notice.index.alreadyBuilding": "The index is already building.",
    "notice.index.stopRequested": "Requested index build stop.",
    "notice.index.stopped": "Index build stopped.",
    "notice.index.noActiveBuild": "No index build is currently running.",
    "notice.index.clearWhileBusy": "The index is building. Stop the build before clearing the index.",
    "notice.index.cleared": "Knowledge index cleared.",

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
    "view.indexStatus.building": "Building",
    "view.indexStatus.ready": "Ready",
    "view.indexStatus.notBuilt": "Not built",
    "view.indexStatus.vectorReady": "Ready ({{count}} vectors)",
    "view.indexStatus.vectorDisabled": "Disabled",
    "view.indexStatus.vectorFallback": "Not built / fallback active",
    "view.indexBusy.rebuilding": "Rebuilding knowledge index...",
    "view.indexBusy.syncing": "Syncing knowledge index...",
    "view.indexBusy.vector": "Building vector index...",
    "view.indexBusy.generic": "Building index...",
    "view.retrievalModeLabel": "Retrieval mode:",
    "view.retrieval.keyword": "Keyword search",
    "view.retrieval.vector": "Vector search",
    "view.retrieval.hybrid": "Hybrid search",
    "view.rebuildIndex": "Rebuild index",
    "view.rebuildIndexBusy": "Building...",
    "view.stopIndexBuild": "Stop index",
    "view.clearIndex": "Clear index",
    "view.resetConversation": "Reset conversation",
    "view.modeLabel": "Mode",
    "view.mode.qa": "Q&A",
    "view.mode.exam": "Exam",
    "view.inputPlaceholder": "Ask a question. Press Enter to send, Shift + Enter for a new line",
    "view.send": "Send",
    "view.clear": "Clear",
    "view.stopGenerating": "Stop",
    "view.generationStopped": "Generation stopped.",
    "view.modelStatus.chat": "Chat: {{model}}",
    "view.modelStatus.embedding": "Embedding: {{model}}",
    "view.modelUnset": "Not set",
    "view.noMessages": "No messages yet",
    "view.you": "You",
    "view.sources": "Sources: {{count}}",
    "view.source.pdfPage": "page {{page}}",
    "view.source.pdfPages": "pages {{start}}-{{end}}",
    "view.thinking": "Thinking",
    "view.copyMessage": "Copy message",
    "view.copyMessageSuccess": "Message copied.",
    "view.copyMessageFailed": "Copy failed: {{message}}",
    "view.sendFailed": "Send failed: {{message}}",
    "view.sourceMarkdownFallback": "[VaultCoachView] Source Markdown render failed. Falling back to plain text.",

    "exam.defaultTitle": "VaultCoach exam",
    "exam.unanswered": "(Unanswered)",
    "exam.scope.fullCurrentKnowledgeBase": "Current full knowledge base",
    "exam.setup.title": "Create a test",
    "exam.setup.desc": "Choose a scope and question count. VaultCoach will generate questions from the current knowledge base. After grading, the test is saved to the hidden history folder by default.",
    "exam.scope.title": "Test scope",
    "exam.scope.all": "Full knowledge base",
    "exam.scope.folders": "Selected folders",
    "exam.scope.meta": "{{fileCount}} files · {{chunkCount}} chunks",
    "exam.scope.noFolders": "No subfolders are available in the current knowledge base scope.",
    "exam.files.title": "Exam files",
    "exam.files.summary": "{{total}} files in scope · {{excluded}} excluded · {{eligible}} included",
    "exam.files.capacity": "Current eligible content can support about {{min}}–{{max}} questions",
    "exam.files.capacityEmpty": "The current eligible content is not enough to generate questions",
    "exam.files.manage": "Manage files",
    "exam.files.hideManager": "Hide files",
    "exam.files.noEligible": "No files are eligible for this exam. Include more files, or check frontmatter and excluded path settings.",
    "exam.files.search": "Search file paths",
    "exam.files.includeAll": "Select all",
    "exam.files.excludeAll": "Exclude all",
    "exam.files.reset": "Restore default",
    "exam.files.noMatches": "No matching files.",
    "exam.files.rootFolder": "Vault root",
    "exam.files.chunkCount": "{{count}} chunks",
    "exam.files.permanentExcluded": "Rule excluded",
    "exam.files.permanentReason": "Rule excluded: {{reason}}",
    "exam.files.manualExcluded": "Manually excluded",
    "exam.questionCount": "Questions",
    "exam.analyze": "Analyze exam scope",
    "exam.reanalyze": "Reanalyze exam content",
    "exam.start": "Generate test",
    "exam.cancel": "Cancel",
    "exam.cancelling": "Cancelling",
    "exam.generating": "Generating questions from the knowledge base",
    "exam.evaluating": "Grading",
    "exam.progress.resolvingScope": "Collecting exam files",
    "exam.progress.ruleFiltering": "Applying folder, file, and rule filters",
    "exam.progress.semanticFiltering": "Analyzing content",
    "exam.progress.semanticFilteringCount": "Analyzing content {{current}} / {{total}}",
    "exam.progress.planning": "Planning knowledge coverage",
    "exam.progress.generating": "Generating questions",
    "exam.progress.generatingCount": "Generating questions {{current}} / {{total}}",
    "exam.progress.validating": "Checking question quality",
    "exam.progress.repairing": "Repairing model output",
    "exam.progress.completed": "Completed",
    "exam.analysis.running": "Analyzing exam scope",
    "exam.analysis.complete": "Scope analysis complete",
    "exam.analysis.totalFiles": "Total files",
    "exam.analysis.ruleExcluded": "Rule excluded",
    "exam.analysis.semanticExcluded": "Smart excluded",
    "exam.analysis.partial": "Partially usable",
    "exam.analysis.included": "Fully usable",
    "exam.analysis.forceIncluded": "Force included",
    "exam.analysis.capacity": "Capacity",
    "exam.analysis.cache": "Cache hits",
    "exam.analysis.details": "View filtering details",
    "exam.analysis.exclude": "Exclude",
    "exam.analysis.forceInclude": "Force include",
    "exam.analysis.failedTitle": "Smart content filtering failed",
    "exam.analysis.failedDesc": "Folder and file rules have already been applied. Retry smart filtering, or continue using only the manually selected scope.",
    "exam.analysis.retry": "Retry smart filtering",
    "exam.analysis.continueManual": "Continue with manual scope",
    "exam.taking.title": "Answer",
    "exam.taking.desc": "Submit after answering. After grading, the test is saved to the hidden history folder by default, and you can also export it from the result page.",
    "exam.answerPlaceholder": "Type your answer here",
    "exam.submit": "Submit for grading",
    "exam.delete": "Delete test",
    "exam.save": "Save result",
    "exam.history": "Exam history",
    "exam.newTest": "Create new test",
    "exam.review.title": "Test result",
    "exam.score": "Score",
    "exam.overallFeedback": "Overall feedback",
    "exam.userAnswer": "User answer",
    "exam.referenceAnswer": "Reference answer",
    "exam.rubric": "Rubric",
    "exam.feedback": "Feedback",
    "exam.improvement": "Improvement",
    "exam.sourcePaths": "Source paths",
    "exam.savedPath": "History record: {{path}}",
    "exam.export.title": "Manual export",
    "exam.export.desc": "History is saved in a hidden folder by default. Export a copy to a visible folder when you want it to appear in your notes.",
    "exam.export.placeholder": "Enter a vault folder path, e.g. Exam records",
    "exam.export.button": "Export to folder",
    "exam.history.title": "Exam history",
    "exam.history.back": "Back",
    "exam.history.empty": "No exam history yet.",
    "exam.history.loading": "Loading exam history",
    "exam.history.select": "Select a history record to view details.",
    "exam.history.delete": "Delete",
    "exam.history.unknownDate": "Unknown date",
    "exam.history.noScore": "Ungraded",
    "exam.emptyKnowledge.title": "No available knowledge chunks",
    "exam.emptyKnowledge.desc": "Rebuild the index first, or check the knowledge base scope in settings.",
    "exam.notice.noChunks": "No available knowledge chunks in the selected exam scope.",
    "exam.notice.cancelled": "Exam generation cancelled.",
    "exam.notice.analysisFailed": "Smart filtering failed: {{message}}",
    "exam.notice.createFailed": "Failed to create test: {{message}}",
    "exam.notice.evaluateFailed": "Failed to grade test: {{message}}",
    "exam.notice.saveFailed": "Failed to save test: {{message}}",
    "exam.notice.exported": "Test result exported to: {{path}}",
    "exam.notice.exportFailed": "Failed to export test: {{message}}",
    "exam.notice.deleteFailed": "Failed to delete test: {{message}}",
    "exam.notice.historyFailed": "Failed to load exam history: {{message}}",
    "exam.notice.invalidHistoryPath": "Invalid exam history path.",
    "exam.notice.exportPathIsFile": "The export folder path is already a file.",
    "exam.notice.openSourceFailed": "Failed to open source: {{message}}",
    "exam.notice.saved": "Test result saved.",
    "exam.notice.deleted": "Test deleted.",
    "exam.notice.questionCountReduced": "Requested {{requested}} questions; {{actual}} passed scope and quality checks. This test will use {{actual}} questions.",
    "exam.markdown.id": "Test ID",
    "exam.markdown.createdAt": "Created at",
    "exam.markdown.scope": "Test scope",
    "exam.markdown.questionCount": "Question count",
    "exam.markdown.score": "Score",
    "exam.markdown.overallFeedback": "Overall feedback",
    "exam.markdown.questions": "Questions and answers",
    "exam.markdown.userAnswer": "User answer",
    "exam.markdown.referenceAnswer": "Reference answer",
    "exam.markdown.rubric": "Rubric",
    "exam.markdown.evaluation": "Grading feedback",
    "exam.markdown.feedback": "Feedback",
    "exam.markdown.improvement": "Improvement",
    "exam.markdown.sources": "Sources",

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
    "settings.knowledge.desc": "Control scan scope, indexed file types, and chunking. Rebuild the index after changes.",
    "settings.scope.name": "Scan scope",
    "settings.scope.wholeVault": "Entire vault",
    "settings.scope.specificFolder": "Specific folder",
    "settings.folder.name": "Specific folder",
    "settings.folder.desc": "Only used when scan scope is set to a specific folder.",
    "settings.folder.placeholder": "Enter folder path",
    "settings.markdownIndexing.name": "Index Markdown files",
    "settings.markdownIndexing.desc": "Scan Markdown notes within the configured knowledge base scope.",
    "settings.pdfIndexing.name": "Index text-based PDFs",
    "settings.pdfIndexing.desc": "When disabled, PDFs are not read. When enabled, VaultCoach extracts native PDF text for Q&A, retrieval, and exams; cloud embeddings receive the extracted PDF text.",
    "settings.maxPdfFileSize.name": "PDF file size limit (MB)",
    "settings.maxPdfFileSize.desc": "PDFs above this limit are skipped to avoid excessive indexing time and embedding cost.",
    "settings.maxPdfPageCount.name": "PDF page limit",
    "settings.maxPdfPageCount.desc": "PDFs above this limit are skipped. Scanned PDFs are not OCRed yet.",
    "settings.chunkSize.name": "Chunk size",
    "settings.chunkSize.desc": "Maximum characters per chunk. Larger chunks preserve more context but increase embedding and generation cost.",
    "settings.chunkOverlap.name": "Chunk overlap",
    "settings.chunkOverlap.desc": "Characters preserved between adjacent chunks to reduce boundary loss.",
    "settings.autoSync.name": "Enable automatic incremental sync",
    "settings.autoSync.desc": "Watch enabled knowledge file changes in the vault and sync the index after the threshold or time window is reached.",
    "settings.autoSyncThreshold.name": "Auto-sync file threshold",
    "settings.autoSyncThreshold.desc": "Trigger incremental sync immediately when this many changed knowledge files are queued.",
    "settings.autoSyncDebounce.name": "Auto-sync debounce time (ms)",
    "settings.autoSyncDebounce.desc": "Wait this long after the latest file change before syncing to avoid frequent rebuilds.",
    "settings.autoSyncMaxWait.name": "Auto-sync maximum wait (ms)",
    "settings.autoSyncMaxWait.desc": "Force a sync after this time even if file changes keep arriving.",
    "settings.exam.heading": "Exam mode",
    "settings.exam.desc": "Control exam generation scope, long-term exclude rules, and content-quality filtering. Regular Q&A is unaffected.",
    "settings.examExcludePaths.name": "Exam mode excluded paths",
    "settings.examExcludePaths.desc": "Only affects exam mode. Use one vault-relative path or simple glob per line, such as TODO/**, Archive/**, or **/*.draft.md.",
    "settings.examExcludePaths.placeholder": "TODO/**\nDaily Notes/**\nArchive/**\n**/*.draft.md",
    "settings.examSmartFiltering.name": "Smartly exclude low-quality exam content",
    "settings.examSmartFiltering.desc": "Use rules and the configured chat model to identify exam-ready files and sections, reusing the local content-profile cache. Q&A is unaffected.",

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
    "settings.cloudApiKey.desc": "Stored in Obsidian secret storage. Remote models receive the user's question, knowledge chunks, retrieval context, exam filtering/generation/review excerpts, and a small amount of conversation context.",
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

const LEGACY_DEFAULT_GREETINGS: string[] = [
    [
        "# 你好，我是 VaultCoach",
        "",
        "当前版本已经支持：",
        "- Markdown 知识库扫描与标题切块；",
        "- 关键词检索；",
        "- Query rewrite；",
        "- Embedding / 向量检索；",
        "- Hybrid merge；",
        "- Rerank；",
        "- Markdown 格式回答渲染；",
        "- 对话持久化；",
        "- 本地长期记忆；",
        "- 自动增量索引同步。",
    ].join("\n"),
];

/**
 * 检测 Obsidian 当前界面语言。
 */
export function detectObsidianLocale(): SupportedLocale {
    const obsidianLanguage: string | null = readObsidianLanguage();
    if (obsidianLanguage !== null) {
        return languageToSupportedLocale(obsidianLanguage);
    }

    return detectBrowserLocale();
}

/**
 * 检测系统语言。
 *
 * 当前等同于 Obsidian 语言检测，保留独立函数便于后续扩展。
 */
export function detectSystemLocale(): SupportedLocale {
    return detectObsidianLocale();
}

/**
 * 安全读取 Obsidian 语言设置。
 */
function readObsidianLanguage(): string | null {
    try {
        const language: string = getLanguage();
        return language.trim().length > 0 ? language : null;
    } catch {
        return null;
    }
}

/**
 * 在无法读取 Obsidian 语言时回退到浏览器语言。
 */
function detectBrowserLocale(): SupportedLocale {
    const language: string | null = getFirstBrowserLanguage();
    return language === null ? "en" : languageToSupportedLocale(language);
}

/**
 * 获取浏览器首选语言。
 */
function getFirstBrowserLanguage(): string | null {
    if (typeof navigator === "undefined") {
        return null;
    }

    for (const language of navigator.languages) {
        if (language.trim().length > 0) {
            return language;
        }
    }

    return navigator.language.trim().length > 0 ? navigator.language : null;
}

/**
 * 将任意语言标记映射为插件支持的语言。
 */
function languageToSupportedLocale(language: string): SupportedLocale {
    return isChineseLocale(language) ? "zh" : "en";
}

/**
 * 根据 key 获取本地化文案，并替换 `{{name}}` 形式的占位符。
 */
export function translate(
    key: TranslationKey,
    replacements: Record<string, string | number> = {},
    locale: SupportedLocale = detectObsidianLocale(),
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

/**
 * 获取对应语言的默认欢迎语。
 */
export function getDefaultGreeting(locale: SupportedLocale = detectObsidianLocale()): string {
    return DEFAULT_GREETINGS[locale];
}

/**
 * 判断用户保存的欢迎语是否仍是内置默认文案。
 *
 * 用于语言切换或版本升级后自动刷新默认欢迎语，同时不覆盖用户自定义内容。
 */
export function isBuiltInDefaultGreeting(value: string): boolean {
    const normalizedValue: string = normalizeGreeting(value);
    return normalizeGreeting(DEFAULT_GREETINGS.zh) === normalizedValue
        || normalizeGreeting(DEFAULT_GREETINGS.en) === normalizedValue
        || LEGACY_DEFAULT_GREETINGS.some((greeting: string) => normalizeGreeting(greeting) === normalizedValue);
}

/**
 * 判断语言标签是否为中文区域。
 */
function isChineseLocale(language: string): boolean {
    const normalizedLanguage: string = language.toLowerCase().replace("_", "-");
    return normalizedLanguage === "zh" || normalizedLanguage.startsWith("zh-");
}

/**
 * 归一化欢迎语，便于比较不同版本中的内置文案。
 */
function normalizeGreeting(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

/**
 * 转义用户传入的占位符 key，安全拼接到正则表达式中。
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
