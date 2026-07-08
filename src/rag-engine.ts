import { DEFAULT_RRF_K } from "./constants";
import { VaultKnowledgeBase } from "./knowledge-base";
import { LocalModelClient } from "./model-client";
import type {
    AnswerSource,
    AssistantAnswer,
    ChatMessage,
    ChunkEmbedding,
    ExamEvaluation,
    ExamEvaluationItem,
    ExamQuestion,
    ExamSession,
    IndexedChunk,
    KnowledgeBaseSyncResult,
    KeywordSearchHit,
    LocalChatMessage,
    QueryRewriteResult,
    RerankedCandidate,
    RetrievalCandidate,
    RetrievalMode,
    RerankResultItem,
    StreamHandlers,
    VectorIndexStats,
    VectorSearchHit,
    VaultCoachSettings,
} from "./types";

interface PreparedAnswer {
    promptMessages: LocalChatMessage[];
    sources: AnswerSource[];
    rerankedCandidates: RerankedCandidate[];
    retrievalModeUsed: RetrievalMode;
    rewriteResult: QueryRewriteResult;
    originalUserText: string;
    noCandidates: boolean;
}

interface GeneratedExamQuestionPayload {
    id?: string;
    question?: string;
    reference_answer?: string;
    rubric?: string;
    source_paths?: string[];
}

interface GeneratedExamPayload {
    title?: string;
    questions?: GeneratedExamQuestionPayload[];
}

interface ExamEvaluationItemPayload {
    id?: string;
    question_id?: string;
    score?: number;
    max_score?: number;
    feedback?: string;
    improvement?: string;
}

interface ExamEvaluationPayload {
    score?: number;
    max_score?: number;
    overall_feedback?: string;
    items?: ExamEvaluationItemPayload[];
}

export class AdvancedRagEngine {
    private readonly knowledgeBase: VaultKnowledgeBase;
    private readonly getSettings: () => VaultCoachSettings;
    private readonly getRuntimeRetrievalMode: () => RetrievalMode;
    private readonly client: LocalModelClient;

    private vectorStats: VectorIndexStats = {
        ready: false,
        vectorCount: 0,
        dimension: null,
        lastBuiltAt: null,
    };

    constructor(
        knowledgeBase: VaultKnowledgeBase,
        getSettings: () => VaultCoachSettings,
        getRuntimeRetrievalMode: () => RetrievalMode,
        getCloudApiKey: () => string | null,
    ) {
        this.knowledgeBase = knowledgeBase;
        this.getSettings = getSettings;
        this.getRuntimeRetrievalMode = getRuntimeRetrievalMode;
        this.client = new LocalModelClient(getSettings, getCloudApiKey);
    }

    getVectorIndexStats(): VectorIndexStats {
        return { ...this.vectorStats };
    }

    consumeOllamaEmbeddingCpuFallbackUsed(): boolean {
        return this.client.consumeOllamaEmbeddingCpuFallbackUsed();
    }

    // 新增：从磁盘恢复向量索引状态。
    hydrateVectorStats(vectorStats: VectorIndexStats): void {
        this.vectorStats = { ...vectorStats };
    }

    // 新增：根据当前知识库中的向量快照重新计算统计信息。
    refreshVectorStatsFromKnowledgeBase(): VectorIndexStats {
        const embeddings: ChunkEmbedding[] = this.knowledgeBase.getEmbeddingSnapshot();
        this.vectorStats = {
            ready: embeddings.length > 0,
            vectorCount: embeddings.length,
            dimension: embeddings[0]?.vector.length ?? null,
            lastBuiltAt: embeddings.length > 0 ? Date.now() : null,
        };
        return this.getVectorIndexStats();
    }

    async rebuildVectorIndex(): Promise<VectorIndexStats> {
        const settings: VaultCoachSettings = this.getSettings();
        this.knowledgeBase.clearVectorIndex();
        this.vectorStats = {
            ready: false,
            vectorCount: 0,
            dimension: null,
            lastBuiltAt: null,
        };

        if (!settings.enableVectorRetrieval || this.getActiveEmbeddingModel(settings).length === 0) {
            return this.getVectorIndexStats();
        }

        const chunks: IndexedChunk[] = this.knowledgeBase.getAllChunks();
        if (chunks.length === 0) {
            return this.getVectorIndexStats();
        }

        const items: ChunkEmbedding[] = await this.buildChunkEmbeddings(chunks);
        this.knowledgeBase.setEmbeddings(items);
        this.vectorStats = {
            ready: items.length > 0,
            vectorCount: items.length,
            dimension: items[0]?.vector.length ?? null,
            lastBuiltAt: Date.now(),
        };

        return this.getVectorIndexStats();
    }

    // 新增：增量同步时只为发生变化的 chunk 重算 embedding。
    async syncVectorIndex(syncResult: KnowledgeBaseSyncResult): Promise<VectorIndexStats> {
        const settings: VaultCoachSettings = this.getSettings();

        if (!settings.enableVectorRetrieval || this.getActiveEmbeddingModel(settings).length === 0) {
            this.knowledgeBase.clearVectorIndex();
            this.vectorStats = {
                ready: false,
                vectorCount: 0,
                dimension: null,
                lastBuiltAt: null,
            };
            return this.getVectorIndexStats();
        }

        if (syncResult.removedChunkIds.length > 0) {
            this.knowledgeBase.removeEmbeddings(syncResult.removedChunkIds);
        }

        if (syncResult.changedChunks.length > 0) {
            const items: ChunkEmbedding[] = await this.buildChunkEmbeddings(syncResult.changedChunks);
            this.knowledgeBase.upsertEmbeddings(items);
        }

        const embeddings: ChunkEmbedding[] = this.knowledgeBase.getEmbeddingSnapshot();
        this.vectorStats = {
            ready: embeddings.length > 0,
            vectorCount: embeddings.length,
            dimension: embeddings[0]?.vector.length ?? null,
            lastBuiltAt: Date.now(),
        };

        return this.getVectorIndexStats();
    }

    private getActiveEmbeddingModel(settings: VaultCoachSettings): string {
        return settings.embeddingProvider === "openai-compatible"
            ? settings.cloudEmbeddingModel.trim()
            : settings.embeddingModel.trim();
    }

    async answerQuestion(
        userText: string,
        messages: ChatMessage[],
        scopeDescription: string,
        memoryContext: string,
    ): Promise<AssistantAnswer> {
        const prepared: PreparedAnswer = await this.prepareAnswer(
            userText,
            messages,
            scopeDescription,
            memoryContext,
        );

        if (prepared.noCandidates) {
            return {
                text: this.buildFallbackMarkdownAnswer(
                    prepared.originalUserText,
                    prepared.rewriteResult,
                    prepared.retrievalModeUsed,
                    prepared.rerankedCandidates,
                ),
                sources: [],
                retrievalModeUsed: prepared.retrievalModeUsed,
                queryRewrite: prepared.rewriteResult,
            };
        }

        try {
            const markdownAnswer: string = await this.client.generateMarkdownAnswer(
                prepared.promptMessages,
                this.getSettings().generationTemperature,
            );

            return {
                text: markdownAnswer,
                sources: prepared.sources,
                retrievalModeUsed: prepared.retrievalModeUsed,
                queryRewrite: prepared.rewriteResult,
            };
        } catch (error: unknown) {
            console.error("[VaultCoach] 生成回答失败，将回退到检索结果摘要。", error);

            return {
                text: this.buildFallbackMarkdownAnswer(
                    prepared.originalUserText,
                    prepared.rewriteResult,
                    prepared.retrievalModeUsed,
                    prepared.rerankedCandidates,
                ),
                sources: prepared.sources,
                retrievalModeUsed: prepared.retrievalModeUsed,
                queryRewrite: prepared.rewriteResult,
            };
        }
    }

    // 新增：最终回答使用流式输出，完成后仍返回完整 AssistantAnswer。
    async streamAnswerQuestion(
        userText: string,
        messages: ChatMessage[],
        scopeDescription: string,
        memoryContext: string,
        handlers?: StreamHandlers,
    ): Promise<AssistantAnswer> {
        const prepared: PreparedAnswer = await this.prepareAnswer(
            userText,
            messages,
            scopeDescription,
            memoryContext,
        );

        if (prepared.noCandidates) {
            return {
                text: this.buildFallbackMarkdownAnswer(
                    prepared.originalUserText,
                    prepared.rewriteResult,
                    prepared.retrievalModeUsed,
                    prepared.rerankedCandidates,
                ),
                sources: [],
                retrievalModeUsed: prepared.retrievalModeUsed,
                queryRewrite: prepared.rewriteResult,
            };
        }

        try {
            const markdownAnswer: string = await this.client.streamMarkdownAnswer(
                prepared.promptMessages,
                this.getSettings().generationTemperature,
                handlers,
            );

            return {
                text: markdownAnswer,
                sources: prepared.sources,
                retrievalModeUsed: prepared.retrievalModeUsed,
                queryRewrite: prepared.rewriteResult,
            };
        } catch (streamError: unknown) {
            console.error("[VaultCoach] 流式回答失败，将回退到非流式回答。", streamError);

            try {
                const markdownAnswer: string = await this.client.generateMarkdownAnswer(
                    prepared.promptMessages,
                    this.getSettings().generationTemperature,
                );

                if (markdownAnswer.length > 0) {
                    handlers?.onToken?.(markdownAnswer);
                }
                handlers?.onDone?.();

                return {
                    text: markdownAnswer,
                    sources: prepared.sources,
                    retrievalModeUsed: prepared.retrievalModeUsed,
                    queryRewrite: prepared.rewriteResult,
                };
            } catch (error: unknown) {
                console.error("[VaultCoach] 非流式回退也失败，将回退到检索结果摘要。", error);
                handlers?.onError?.(error);

                return {
                    text: this.buildFallbackMarkdownAnswer(
                        prepared.originalUserText,
                        prepared.rewriteResult,
                        prepared.retrievalModeUsed,
                        prepared.rerankedCandidates,
                    ),
                    sources: prepared.sources,
                    retrievalModeUsed: prepared.retrievalModeUsed,
                    queryRewrite: prepared.rewriteResult,
                };
            }
        }
    }

    // 新增：对外暴露长期记忆抽取入口，由主插件负责持久化与去重。
    async extractMemoryStatements(
        userText: string,
        assistantText: string,
        messages: ChatMessage[],
    ): Promise<string[]> {
        return this.client.extractMemoryStatements(
            this.buildConversationContext(messages),
            userText,
            assistantText,
        );
    }

    async generateExamSession(
        scopeLabel: string,
        selectedFolderPaths: string[],
        chunks: IndexedChunk[],
        questionCount: number,
    ): Promise<ExamSession> {
        const contextChunks: IndexedChunk[] = this.selectExamContextChunks(chunks, 18, 12000);
        if (contextChunks.length === 0) {
            throw new Error("当前考试范围内没有可用的知识库片段。");
        }

        const normalizedQuestionCount: number = Math.max(1, Math.min(10, Math.floor(questionCount)));
        const sourcePathFallbacks: string[] = Array.from(new Set(contextChunks.map((chunk: IndexedChunk) => chunk.filePath))).slice(0, 5);
        const messages: LocalChatMessage[] = [
            {
                role: "system",
                content: [
                    "你是 VaultCoach 的考试出题器。",
                    "你的任务是严格基于用户提供的 Obsidian 知识库上下文生成测试题。",
                    "必须遵守：",
                    "1. 只根据给定上下文出题，不要引入上下文之外的事实。",
                    "2. 题目应该考察理解、解释、对比、应用，而不是只做原文抄写。",
                    "3. 使用与上下文主要语言一致的语言；如果中英文混合，默认使用中文。",
                    "4. 输出严格 JSON，不要使用 Markdown，不要包裹代码块。",
                    "5. 每题必须包含清晰的参考答案和评分标准。",
                    "6. 所有字符串必须是合法 JSON string；不要在字符串内部直接换行。",
                    "7. 字段值中不要使用未转义的英文双引号；需要引用时优先使用中文引号或单引号。",
                    "8. 题目、参考答案和评分标准中不要出现 EXCERPT_ID、SOURCE_PATH、HEADING、片段编号等内部上下文标记。",
                    "9. 评分标准必须使用 100 分制；不要出现 2 分、5 分、10 分等非满分 100 的总分口径。",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    `考试范围：${scopeLabel}`,
                    `题目数量：${normalizedQuestionCount}`,
                    "",
                    "请输出 JSON，schema 如下：",
                    "{",
                    "  \"title\": \"测试标题\",",
                    "  \"questions\": [",
                    "    {",
                    "      \"id\": \"q1\",",
                    "      \"question\": \"题目\",",
                    "      \"reference_answer\": \"参考答案\",",
                    "      \"rubric\": \"评分标准\",",
                    "      \"source_paths\": [\"来源文件路径\"]",
                    "    }",
                    "  ]",
                    "}",
                    "",
                    "知识库上下文：",
                    this.buildExamContextBlock(contextChunks),
                ].join("\n"),
            },
        ];

        const payload: GeneratedExamPayload = await this.generateParsedJsonAnswer<GeneratedExamPayload>(
            messages,
            0.1,
            this.buildGeneratedExamJsonSchemaDescription(),
            "考试题目生成",
        );
        const questions: ExamQuestion[] = this.normalizeGeneratedExamQuestions(
            payload.questions ?? [],
            normalizedQuestionCount,
            sourcePathFallbacks,
        );

        if (questions.length === 0) {
            throw new Error("模型没有生成可用题目。");
        }

        const now: number = Date.now();
        return {
            id: this.createExamId(now),
            title: this.normalizeText(payload.title, "VaultCoach 测试"),
            createdAt: now,
            scopeLabel,
            selectedFolderPaths: [...selectedFolderPaths],
            questions,
            userAnswers: questions.map(() => ""),
            evaluation: null,
            savedPath: null,
            status: "draft",
        };
    }

    async evaluateExamSession(session: ExamSession, userAnswers: string[]): Promise<ExamEvaluation> {
        const answerBlocks: string[] = session.questions.map((question: ExamQuestion, index: number) => {
            const userAnswer: string = userAnswers[index]?.trim() ?? "";
            return [
                `## ${question.id}`,
                `题目：${question.question}`,
                `参考答案：${question.referenceAnswer}`,
                `评分标准：${question.rubric}`,
                `用户答案：${userAnswer.length > 0 ? userAnswer : "（未作答）"}`,
            ].join("\n");
        });

        const messages: LocalChatMessage[] = [
            {
                role: "system",
                content: [
                    "你是 VaultCoach 的考试评分器。",
                    "你的任务是根据题目、参考答案、评分标准和用户答案进行稳定评分。",
                    "必须遵守：",
                    "1. 只评价用户答案是否覆盖参考答案中的关键点。",
                    "2. 不要因为表达方式不同而扣分，只要含义正确即可。",
                    "3. 未作答或明显无关答案应给低分。",
                    "4. 每题 max_score 必须是 100，score 必须是 0 到 100 的数字。",
                    "5. 总分 score 是所有题目百分制得分的平均值，max_score 必须是 100。",
                    "6. 输出严格 JSON，不要使用 Markdown，不要包裹代码块。",
                    "7. 所有字符串必须是合法 JSON string；不要在字符串内部直接换行。",
                    "8. 字段值中不要使用未转义的英文双引号；需要引用时优先使用中文引号或单引号。",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    `测试标题：${session.title}`,
                    `题目数量：${session.questions.length}`,
                    "",
                    "请输出 JSON，schema 如下：",
                    "{",
                    "  \"score\": 82,",
                    "  \"max_score\": 100,",
                    "  \"overall_feedback\": \"总体反馈\",",
                    "  \"items\": [",
                    "    {",
                    "      \"question_id\": \"q1\",",
                    "      \"score\": 80,",
                    "      \"max_score\": 100,",
                    "      \"feedback\": \"本题反馈\",",
                    "      \"improvement\": \"改进建议\"",
                    "    }",
                    "  ]",
                    "}",
                    "",
                    "待评分内容：",
                    answerBlocks.join("\n\n"),
                ].join("\n"),
            },
        ];

        const payload: ExamEvaluationPayload = await this.generateParsedJsonAnswer<ExamEvaluationPayload>(
            messages,
            0,
            this.buildExamEvaluationJsonSchemaDescription(),
            "考试评分",
        );
        return this.normalizeExamEvaluation(payload, session.questions);
    }

    private async generateParsedJsonAnswer<T>(
        messages: LocalChatMessage[],
        temperature: number,
        schemaDescription: string,
        taskLabel: string,
    ): Promise<T> {
        const rawJson: string = await this.client.generateJsonAnswer(messages, temperature);

        try {
            return this.parseJsonObject(rawJson) as T;
        } catch (parseError: unknown) {
            console.warn(`[VaultCoach] ${taskLabel}返回的 JSON 无法直接解析，尝试让模型修复。`, parseError);
        }

        const repairMessages: LocalChatMessage[] = [
            {
                role: "system",
                content: [
                    "你是一个严格 JSON 修复器。",
                    "你的任务是把用户提供的模型输出修复为可以被 JSON.parse 解析的 JSON。",
                    "必须遵守：",
                    "1. 只输出 JSON 对象，不要输出 Markdown、解释或代码块。",
                    "2. 不要新增、删除或改写字段含义。",
                    "3. 修复未转义双引号、字符串内部原始换行、尾随逗号等语法问题。",
                    "4. 如果某个字符串需要换行，请改为普通空格或使用 \\n 转义。",
                    "5. 输出必须符合用户给出的 schema。",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    `任务：${taskLabel}`,
                    "",
                    "目标 schema：",
                    schemaDescription,
                    "",
                    "待修复的原始输出：",
                    this.truncateModelOutputForRepair(rawJson),
                ].join("\n"),
            },
        ];

        const repairedJson: string = await this.client.generateJsonAnswer(repairMessages, 0);
        try {
            return this.parseJsonObject(repairedJson) as T;
        } catch (repairError: unknown) {
            console.error(`[VaultCoach] ${taskLabel}的 JSON 修复仍然失败。`, repairError);
            throw new Error(`${taskLabel}失败：模型返回的 JSON 无法解析，请重试或换用更稳定的聊天模型。`);
        }
    }

    private buildGeneratedExamJsonSchemaDescription(): string {
        return [
            "{",
            "  \"title\": \"测试标题\",",
            "  \"questions\": [",
            "    {",
            "      \"id\": \"q1\",",
            "      \"question\": \"题目\",",
            "      \"reference_answer\": \"参考答案\",",
            "      \"rubric\": \"评分标准\",",
            "      \"source_paths\": [\"来源文件路径\"]",
            "    }",
            "  ]",
            "}",
        ].join("\n");
    }

    private buildExamEvaluationJsonSchemaDescription(): string {
        return [
            "{",
            "  \"score\": 82,",
            "  \"max_score\": 100,",
            "  \"overall_feedback\": \"总体反馈\",",
            "  \"items\": [",
            "    {",
            "      \"question_id\": \"q1\",",
            "      \"score\": 80,",
            "      \"max_score\": 100,",
            "      \"feedback\": \"本题反馈\",",
            "      \"improvement\": \"改进建议\"",
            "    }",
            "  ]",
            "}",
        ].join("\n");
    }

    private truncateModelOutputForRepair(rawText: string): string {
        const maxCharacters = 16000;
        if (rawText.length <= maxCharacters) {
            return rawText;
        }

        return `${rawText.slice(0, maxCharacters)}\n...`;
    }

    private selectExamContextChunks(chunks: IndexedChunk[], maxChunks: number, maxCharacters: number): IndexedChunk[] {
        if (chunks.length <= maxChunks) {
            return this.limitChunksByCharacters(chunks, maxCharacters);
        }

        const selectedChunks: IndexedChunk[] = [];
        const step: number = Math.max(1, Math.floor(chunks.length / maxChunks));

        for (let index = 0; index < chunks.length && selectedChunks.length < maxChunks; index += step) {
            const chunk: IndexedChunk | undefined = chunks[index];
            if (chunk) {
                selectedChunks.push(chunk);
            }
        }

        return this.limitChunksByCharacters(selectedChunks, maxCharacters);
    }

    private limitChunksByCharacters(chunks: IndexedChunk[], maxCharacters: number): IndexedChunk[] {
        const selectedChunks: IndexedChunk[] = [];
        let usedCharacters = 0;

        for (const chunk of chunks) {
            const nextSize: number = chunk.text.length + chunk.filePath.length + 80;
            if (selectedChunks.length > 0 && usedCharacters + nextSize > maxCharacters) {
                break;
            }

            selectedChunks.push(chunk);
            usedCharacters += nextSize;
        }

        return selectedChunks;
    }

    private buildExamContextBlock(chunks: IndexedChunk[]): string {
        return chunks.map((chunk: IndexedChunk, index: number) => {
            const headingLabel: string = chunk.headingPath.length > 0
                ? chunk.headingPath.join(" > ")
                : "（无标题）";
            return [
                `<excerpt id="E${index + 1}">`,
                `SOURCE_PATH: ${chunk.filePath}`,
                `HEADING: ${headingLabel}`,
                "TEXT:",
                chunk.text,
                "</excerpt>",
            ].join("\n");
        }).join("\n\n");
    }

    private normalizeGeneratedExamQuestions(
        payloadQuestions: GeneratedExamQuestionPayload[],
        questionCount: number,
        sourcePathFallbacks: string[],
    ): ExamQuestion[] {
        const questions: ExamQuestion[] = [];

        for (let index = 0; index < payloadQuestions.length && questions.length < questionCount; index += 1) {
            const payloadQuestion: GeneratedExamQuestionPayload | undefined = payloadQuestions[index];
            if (!payloadQuestion) {
                continue;
            }

            const question: string = this.stripInternalContextLabels(this.normalizeText(payloadQuestion.question, ""));
            const referenceAnswer: string = this.stripInternalContextLabels(this.normalizeText(payloadQuestion.reference_answer, ""));
            const rubric: string = this.normalizeRubricText(this.stripInternalContextLabels(this.normalizeText(payloadQuestion.rubric, "")));

            if (question.length === 0 || referenceAnswer.length === 0 || rubric.length === 0) {
                continue;
            }

            const fallbackId: string = `q${questions.length + 1}`;
            const sourcePaths: string[] = Array.isArray(payloadQuestion.source_paths)
                ? payloadQuestion.source_paths
                    .filter((path: unknown): path is string => typeof path === "string")
                    .map((path: string) => path.trim())
                    .filter((path: string) => path.length > 0)
                : [];

            questions.push({
                id: this.normalizeQuestionId(payloadQuestion.id, fallbackId),
                question,
                referenceAnswer,
                rubric,
                sourcePaths: sourcePaths.length > 0 ? Array.from(new Set(sourcePaths)) : [...sourcePathFallbacks],
            });
        }

        return questions;
    }

    private stripInternalContextLabels(value: string): string {
        return value
            .replace(/上下文\s*\d+/gi, "")
            .replace(/context\s*\d+/gi, "")
            .replace(/excerpt[_\s-]*id\s*[:：]?\s*E?\d+/gi, "")
            .replace(/SOURCE_PATH\s*[:：][^\n。；;]*/g, "")
            .replace(/HEADING\s*[:：][^\n。；;]*/g, "")
            .replace(/\bE\d+\b/g, "")
            .replace(/\s{2,}/g, " ")
            .replace(/\s+([，。；：！？,.!?;:])/g, "$1")
            .trim();
    }

    private normalizeRubricText(value: string): string {
        const cleanedValue: string = value
            .replace(/满分\s*\d+\s*分/g, "满分 100 分")
            .replace(/总分\s*\d+\s*分/g, "总分 100 分")
            .replace(/每(?:个|点|项)?\s*\d+\s*分/g, "按覆盖程度给分")
            .trim();

        if (/100\s*分|百分制/.test(cleanedValue)) {
            return cleanedValue;
        }

        return `本题按 100 分制评分；${cleanedValue}`;
    }

    private normalizeExamEvaluation(payload: ExamEvaluationPayload, questions: ExamQuestion[]): ExamEvaluation {
        const itemPayloads: ExamEvaluationItemPayload[] = Array.isArray(payload.items) ? payload.items : [];
        const items: ExamEvaluationItem[] = questions.map((question: ExamQuestion, index: number) => {
            const payloadItem: ExamEvaluationItemPayload | undefined = itemPayloads.find((item: ExamEvaluationItemPayload) => {
                return item.question_id === question.id || item.id === question.id;
            }) ?? itemPayloads[index];

            return {
                questionId: question.id,
                score: this.clampScore(payloadItem?.score ?? 0, 0, 100),
                maxScore: 100,
                feedback: this.normalizeText(payloadItem?.feedback, "未提供本题反馈。"),
                improvement: this.normalizeText(payloadItem?.improvement, "请对照参考答案补全关键点。"),
            };
        });

        const scoreFromItems: number = items.length > 0
            ? Math.round(items.reduce((sum: number, item: ExamEvaluationItem) => {
                return sum + (item.score / Math.max(1, item.maxScore)) * (100 / items.length);
            }, 0))
            : 0;

        return {
            score: this.clampScore(payload.score ?? scoreFromItems, 0, 100),
            maxScore: 100,
            overallFeedback: this.normalizeText(payload.overall_feedback, "评分完成。"),
            items,
        };
    }

    private parseJsonObject(rawText: string): unknown {
        const trimmedText: string = rawText.trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/```$/i, "")
            .trim();

        try {
            return JSON.parse(trimmedText) as unknown;
        } catch {
            const startIndex: number = trimmedText.indexOf("{");
            const endIndex: number = trimmedText.lastIndexOf("}");
            if (startIndex >= 0 && endIndex > startIndex) {
                return JSON.parse(trimmedText.slice(startIndex, endIndex + 1)) as unknown;
            }

            throw new Error("模型输出不是有效 JSON。");
        }
    }

    private normalizeQuestionId(value: string | undefined, fallback: string): string {
        const normalizedValue: string = this.normalizeText(value, fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        return normalizedValue.length > 0 ? normalizedValue : fallback;
    }

    private normalizeText(value: string | undefined, fallback: string): string {
        if (typeof value !== "string") {
            return fallback;
        }

        const trimmedValue: string = value.trim();
        return trimmedValue.length > 0 ? trimmedValue : fallback;
    }

    private clampScore(value: number, min: number, max: number): number {
        if (!Number.isFinite(value)) {
            return min;
        }

        return Math.max(min, Math.min(max, Math.round(value)));
    }

    private createExamId(timestamp: number): string {
        return `exam_${new Date(timestamp).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    }

    private async prepareAnswer(
        userText: string,
        messages: ChatMessage[],
        scopeDescription: string,
        memoryContext: string,
    ): Promise<PreparedAnswer> {
        const settings: VaultCoachSettings = this.getSettings();
        const rewriteResult: QueryRewriteResult = await this.client.rewriteQuery(
            userText,
            this.buildConversationContext(messages),
            scopeDescription,
        );

        const retrievalModeUsed: RetrievalMode = this.resolveEffectiveRetrievalMode();
        const retrievalQuery: string = rewriteResult.rewrittenQuery;
        const candidates: RetrievalCandidate[] = await this.retrieveCandidates(retrievalQuery, retrievalModeUsed);

        if (candidates.length === 0) {
            return {
                promptMessages: [],
                sources: [],
                rerankedCandidates: [],
                retrievalModeUsed,
                rewriteResult,
                originalUserText: userText,
                noCandidates: true,
            };
        }

        const rerankedCandidates: RerankedCandidate[] = await this.rerankCandidates(retrievalQuery, candidates);
        const finalContextCandidates: RerankedCandidate[] = rerankedCandidates.slice(0, settings.contextTopK);
        const sources: AnswerSource[] = this.buildAnswerSources(rerankedCandidates);
        const promptMessages: LocalChatMessage[] = this.buildAnswerMessages(
            userText,
            rewriteResult,
            messages,
            finalContextCandidates,
            scopeDescription,
            memoryContext,
        );

        return {
            promptMessages,
            sources,
            rerankedCandidates,
            retrievalModeUsed,
            rewriteResult,
            originalUserText: userText,
            noCandidates: false,
        };
    }

    private resolveEffectiveRetrievalMode(): RetrievalMode {
        const runtimeMode: RetrievalMode = this.getRuntimeRetrievalMode();
        const settings: VaultCoachSettings = this.getSettings();

        if (runtimeMode === "keyword") {
            return "keyword";
        }

        if (!settings.enableVectorRetrieval || !this.knowledgeBase.hasVectorIndex()) {
            return "keyword";
        }

        return runtimeMode;
    }

    private async retrieveCandidates(query: string, mode: RetrievalMode): Promise<RetrievalCandidate[]> {
        if (mode === "keyword") {
            return this.buildCandidatesFromKeywordHits(
                this.knowledgeBase.searchKeyword(query, this.getSettings().keywordSearchTopK),
            );
        }

        if (mode === "vector") {
            try {
                const vectorHits: VectorSearchHit[] = await this.searchVector(query);
                return this.buildCandidatesFromVectorHits(vectorHits);
            } catch (error: unknown) {
                console.error("[VaultCoach] 向量检索失败，将回退到关键词检索。", error);
                return this.buildCandidatesFromKeywordHits(
                    this.knowledgeBase.searchKeyword(query, this.getSettings().keywordSearchTopK),
                );
            }
        }

        const keywordHits: KeywordSearchHit[] = this.knowledgeBase.searchKeyword(query, this.getSettings().keywordSearchTopK);
        let vectorHits: VectorSearchHit[] = [];
        try {
            vectorHits = await this.searchVector(query);
        } catch (error: unknown) {
            console.error("[VaultCoach] 混合检索中的向量召回失败，将只使用关键词召回。", error);
        }
        return this.mergeHybrid(keywordHits, vectorHits, this.getSettings().hybridSearchTopK);
    }

    private async searchVector(query: string): Promise<VectorSearchHit[]> {
        const queryEmbeddings: number[][] = await this.client.embedTexts([query]);
        const queryEmbedding: number[] | undefined = queryEmbeddings[0];
        if (!queryEmbedding) {
            return [];
        }

        return this.knowledgeBase.searchVector(queryEmbedding, this.getSettings().vectorSearchTopK);
    }

    private buildCandidatesFromKeywordHits(hits: KeywordSearchHit[]): RetrievalCandidate[] {
        return hits.map((hit: KeywordSearchHit) => ({
            chunk: hit.chunk,
            score: hit.score,
            matchedTokens: hit.matchedTokens,
            retrievalChannels: ["keyword"],
            keywordScore: hit.score,
        }));
    }

    private buildCandidatesFromVectorHits(hits: VectorSearchHit[]): RetrievalCandidate[] {
        return hits.map((hit: VectorSearchHit) => ({
            chunk: hit.chunk,
            score: hit.score,
            matchedTokens: [],
            retrievalChannels: ["vector"],
            vectorScore: hit.similarity,
        }));
    }

    private mergeHybrid(
        keywordHits: KeywordSearchHit[],
        vectorHits: VectorSearchHit[],
        limit: number,
    ): RetrievalCandidate[] {
        const mergedMap: Map<string, RetrievalCandidate> = new Map<string, RetrievalCandidate>();

        for (let index = 0; index < keywordHits.length; index += 1) {
            const hit: KeywordSearchHit | undefined = keywordHits[index];
            if (!hit) {
                continue;
            }

            const existing: RetrievalCandidate | undefined = mergedMap.get(hit.chunk.id);
            const rrfScore: number = 1 / (DEFAULT_RRF_K + index + 1);

            if (existing) {
                existing.score += rrfScore;
                existing.keywordScore = hit.score;
                existing.matchedTokens = hit.matchedTokens;
                if (!existing.retrievalChannels.includes("keyword")) {
                    existing.retrievalChannels.push("keyword");
                }
                continue;
            }

            mergedMap.set(hit.chunk.id, {
                chunk: hit.chunk,
                score: rrfScore,
                matchedTokens: hit.matchedTokens,
                retrievalChannels: ["keyword"],
                keywordScore: hit.score,
            });
        }

        for (let index = 0; index < vectorHits.length; index += 1) {
            const hit: VectorSearchHit | undefined = vectorHits[index];
            if (!hit) {
                continue;
            }

            const existing: RetrievalCandidate | undefined = mergedMap.get(hit.chunk.id);
            const rrfScore: number = 1 / (DEFAULT_RRF_K + index + 1);

            if (existing) {
                existing.score += rrfScore;
                existing.vectorScore = hit.similarity;
                if (!existing.retrievalChannels.includes("vector")) {
                    existing.retrievalChannels.push("vector");
                }
                continue;
            }

            mergedMap.set(hit.chunk.id, {
                chunk: hit.chunk,
                score: rrfScore,
                matchedTokens: [],
                retrievalChannels: ["vector"],
                vectorScore: hit.similarity,
            });
        }

        const mergedCandidates: RetrievalCandidate[] = Array.from(mergedMap.values());
        mergedCandidates.sort((left: RetrievalCandidate, right: RetrievalCandidate) => right.score - left.score);
        return mergedCandidates.slice(0, limit);
    }

    private async rerankCandidates(query: string, candidates: RetrievalCandidate[]): Promise<RerankedCandidate[]> {
        const settings: VaultCoachSettings = this.getSettings();
        const limitedCandidates: RetrievalCandidate[] = candidates.slice(0, settings.rerankTopK);

        if (!settings.enableRerank) {
            return limitedCandidates.map((candidate: RetrievalCandidate) => ({
                ...candidate,
                retrievalScore: candidate.score,
                rerankScore: candidate.score,
                finalScore: candidate.score,
            }));
        }

        try {
            if (settings.rerankBaseUrl.trim().length > 0 && settings.rerankModel.trim().length > 0) {
                return await this.remoteRerank(query, limitedCandidates);
            }
        } catch (error: unknown) {
            console.error("[VaultCoach] 远程 rerank 失败，将回退到启发式 rerank。", error);
        }

        return this.heuristicRerank(query, limitedCandidates);
    }

    private async remoteRerank(query: string, candidates: RetrievalCandidate[]): Promise<RerankedCandidate[]> {
        const documents: string[] = candidates.map((candidate: RetrievalCandidate) => this.buildRerankDocument(candidate.chunk));
        const results: RerankResultItem[] = await this.client.rerankDocuments(query, documents);
        const scoreByIndex: Map<number, number> = new Map<number, number>();

        for (const item of results) {
            scoreByIndex.set(item.index, item.relevance_score);
        }

        const reranked: RerankedCandidate[] = [];
        for (let index = 0; index < candidates.length; index += 1) {
            const candidate: RetrievalCandidate | undefined = candidates[index];
            if (!candidate) {
                continue;
            }

            const rerankScore: number = scoreByIndex.get(index) ?? 0;
            reranked.push({
                ...candidate,
                retrievalScore: candidate.score,
                rerankScore,
                finalScore: rerankScore + candidate.score * 0.05,
            });
        }

        reranked.sort((left: RerankedCandidate, right: RerankedCandidate) => right.finalScore - left.finalScore);
        return reranked;
    }

    private heuristicRerank(query: string, candidates: RetrievalCandidate[]): RerankedCandidate[] {
        const normalizedQuery: string = this.normalizeForPhraseMatch(query);
        const queryTokens: string[] = Array.from(new Set(this.tokenize(query)));

        const reranked: RerankedCandidate[] = candidates.map((candidate: RetrievalCandidate) => {
            const normalizedText: string = this.normalizeForPhraseMatch(candidate.chunk.searchableText);
            const normalizedHeading: string = this.normalizeForPhraseMatch(candidate.chunk.headingPath.join(" "));
            const chunkTokens: Set<string> = new Set(this.tokenize(candidate.chunk.searchableText));

            let overlapCount = 0;
            for (const token of queryTokens) {
                if (chunkTokens.has(token)) {
                    overlapCount += 1;
                }
            }

            let rerankScore = candidate.score * 0.4;
            rerankScore += overlapCount * 0.15;

            if (normalizedQuery.length > 0 && normalizedText.includes(normalizedQuery)) {
                rerankScore += 1.5;
            }

            if (normalizedQuery.length > 0 && normalizedHeading.includes(normalizedQuery)) {
                rerankScore += 1;
            }

            if ((candidate.vectorScore ?? 0) > 0) {
                rerankScore += (candidate.vectorScore ?? 0) * 0.6;
            }

            if ((candidate.keywordScore ?? 0) > 0) {
                rerankScore += (candidate.keywordScore ?? 0) * 0.05;
            }

            return {
                ...candidate,
                retrievalScore: candidate.score,
                rerankScore,
                finalScore: rerankScore,
            };
        });

        reranked.sort((left: RerankedCandidate, right: RerankedCandidate) => right.finalScore - left.finalScore);
        return reranked;
    }

    private buildAnswerMessages(
        userText: string,
        rewriteResult: QueryRewriteResult,
        conversationMessages: ChatMessage[],
        contextCandidates: RerankedCandidate[],
        scopeDescription: string,
        memoryContext: string,
    ): LocalChatMessage[] {
        const systemPrompt: string = [
            "你是一个运行在 Obsidian 中的本地知识库助手。",
            "你的回答必须严格基于给定的检索上下文，不能虚构知识库中不存在的事实。",
            "回答要求：",
            "1. 使用中文回答；",
            "2. 使用 Markdown 格式组织内容；",
            "3. 优先给出直接结论，再给出必要解释；",
            "4. 如果上下文不足以支撑结论，必须明确说明“根据当前知识库片段，信息不足”；",
            "5. 不要在正文中伪造来源编号，因为插件会在回答下方单独展示可点击来源。",
            "6. 如果问题涉及代码、配置、命令或路径，请尽量使用 Markdown 代码块。",
        ].join("\n");

        const userPrompt: string = [
            `知识库范围：${scopeDescription}`,
            `原始问题：${userText}`,
            `检索查询：${rewriteResult.rewrittenQuery}`,
            "",
            "长期记忆（只保留与当前问题相关的少量内容）：",
            memoryContext || "（无相关长期记忆）",
            "",
            "最近对话（只保留少量上下文，帮助你理解指代关系）：",
            this.buildConversationContext(conversationMessages) || "（无）",
            "",
            "检索上下文如下：",
            this.buildContextBlock(contextCandidates),
            "",
            "请基于以上上下文回答用户问题，并保持结构清晰。",
        ].join("\n");

        return [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ];
    }

    private buildContextBlock(contextCandidates: RerankedCandidate[]): string {
        const blocks: string[] = [];

        for (let index = 0; index < contextCandidates.length; index += 1) {
            const candidate: RerankedCandidate | undefined = contextCandidates[index];
            if (!candidate) {
                continue;
            }

            const headingLabel: string = candidate.chunk.headingPath.length > 0
                ? candidate.chunk.headingPath.join(" > ")
                : "（无标题）";

            blocks.push([
                `### 上下文 ${index + 1}`,
                `- 文件：${candidate.chunk.filePath}`,
                `- 标题路径：${headingLabel}`,
                `- 召回通道：${candidate.retrievalChannels.join(", ")}`,
                "```text",
                candidate.chunk.text,
                "```",
            ].join("\n"));
        }

        return blocks.join("\n\n");
    }

    private buildAnswerSources(candidates: RerankedCandidate[]): AnswerSource[] {
        const uniqueSources: AnswerSource[] = [];
        const seenKeys: Set<string> = new Set<string>();
        const settings: VaultCoachSettings = this.getSettings();

        for (const candidate of candidates) {
            const source: AnswerSource = this.convertChunkToSource(candidate.chunk);
            const uniqueKey: string = `${source.filePath}::${source.heading ?? "__root__"}`;

            if (seenKeys.has(uniqueKey)) {
                continue;
            }

            uniqueSources.push(source);
            seenKeys.add(uniqueKey);

            if (uniqueSources.length >= settings.answerSourceLimit) {
                break;
            }
        }

        return uniqueSources;
    }

    private buildFallbackMarkdownAnswer(
        userText: string,
        rewriteResult: QueryRewriteResult,
        retrievalModeUsed: RetrievalMode,
        candidates: RerankedCandidate[],
    ): string {
        if (candidates.length === 0) {
            return [
                "## 未检索到相关内容",
                "",
                `当前检索模式：\`${retrievalModeUsed}\`。`,
                `检索查询：${rewriteResult.rewrittenQuery}`,
                "",
                "你可以尝试换更具体的关键词，或先手动重建索引。",
            ].join("\n");
        }

        const lines: string[] = [
            "## 检索结果摘要",
            "",
            `- 原始问题：${userText}`,
            `- 检索查询：${rewriteResult.rewrittenQuery}`,
            `- 检索模式：\`${retrievalModeUsed}\``,
            "",
            "当前本地生成模型不可用，因此下面返回的是基于检索结果整理出的摘要：",
            "",
        ];

        for (let index = 0; index < candidates.length; index += 1) {
            const candidate: RerankedCandidate | undefined = candidates[index];
            if (!candidate) {
                continue;
            }

            const title: string = candidate.chunk.primaryHeading
                ? `${candidate.chunk.fileName} > ${candidate.chunk.primaryHeading}`
                : candidate.chunk.fileName;

            lines.push(`### ${index + 1}. ${title}`);
            lines.push("");
            lines.push(this.createExcerpt(candidate.chunk.text, 220));
            lines.push("");
        }

        lines.push("你可以检查本地聊天模型地址、模型名称，或先使用当前检索结果继续定位相关笔记。");
        return lines.join("\n");
    }

    private convertChunkToSource(chunk: IndexedChunk): AnswerSource {
        const displayLink: string = chunk.primaryHeading
            ? `[[${chunk.filePath}#${chunk.primaryHeading}]]`
            : `[[${chunk.filePath}]]`;

        return {
            filePath: chunk.filePath,
            heading: chunk.primaryHeading,
            displayLink,
            excerpt: this.createExcerpt(chunk.text, 180),
        };
    }

    private buildRerankDocument(chunk: IndexedChunk): string {
        return [
            `文件：${chunk.filePath}`,
            `标题：${chunk.headingPath.join(" > ") || "（无标题）"}`,
            "",
            chunk.text,
        ].join("\n");
    }

    private buildConversationContext(messages: ChatMessage[]): string {
        const recentMessages: ChatMessage[] = messages.slice(-6);
        const lines: string[] = [];

        for (const message of recentMessages) {
            const roleLabel: string = message.role === "user" ? "用户" : "助手";
            lines.push(`${roleLabel}：${message.text.replace(/\s+/g, " ").trim()}`);
        }

        return lines.join("\n");
    }

    private createExcerpt(text: string, maxLength: number): string {
        const normalizedText: string = text.replace(/\s+/g, " ").trim();
        if (normalizedText.length <= maxLength) {
            return normalizedText;
        }

        return `${normalizedText.slice(0, maxLength)}…`;
    }

    private tokenize(text: string): string[] {
        const normalizedText: string = text.toLowerCase();
        const tokens: string[] = [];

        const latinMatches: RegExpMatchArray | null = normalizedText.match(/[a-z0-9_./-]+/g);
        if (latinMatches) {
            for (const token of latinMatches) {
                if (token.trim().length > 0) {
                    tokens.push(token.trim());
                }
            }
        }

        const chineseSequences: RegExpMatchArray | null = normalizedText.match(/[\u4e00-\u9fff]+/g);
        if (chineseSequences) {
            for (const sequence of chineseSequences) {
                for (const char of sequence) {
                    tokens.push(char);
                }

                for (let index = 0; index < sequence.length - 1; index += 1) {
                    tokens.push(sequence.slice(index, index + 2));
                }
            }
        }

        return tokens;
    }

    private normalizeForPhraseMatch(text: string): string {
        return text.toLowerCase().replace(/\s+/g, " ").trim();
    }

    private async buildChunkEmbeddings(chunks: IndexedChunk[]): Promise<ChunkEmbedding[]> {
        const batchSize = 16;
        const items: ChunkEmbedding[] = [];

        for (let start = 0; start < chunks.length; start += batchSize) {
            const batchChunks: IndexedChunk[] = chunks.slice(start, start + batchSize);
            const batchTexts: string[] = batchChunks.map((chunk: IndexedChunk) => chunk.searchableText);
            const embeddings: number[][] = await this.client.embedTexts(batchTexts);

            const pairCount: number = Math.min(batchChunks.length, embeddings.length);
            for (let index = 0; index < pairCount; index += 1) {
                const chunk: IndexedChunk | undefined = batchChunks[index];
                const vector: number[] | undefined = embeddings[index];

                if (chunk && vector) {
                    items.push({
                        chunkId: chunk.id,
                        vector,
                    });
                }
            }
        }

        return items;
    }
}
