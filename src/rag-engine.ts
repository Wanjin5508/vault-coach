import { DEFAULT_RRF_K } from "./constants";
import type { DocumentIndexReader } from "./domain/documents/document-index-reader";
import { normalizeObsidianMarkdown } from "./markdown-normalizer";
import { LocalModelClient } from "./model-client";
import { detectQuestionLanguage, type QuestionLanguage } from "./question-language";
import type {
    AnswerSource,
    AssistantAnswer,
    KeywordSearchHit,
    QueryRewriteResult,
    RerankedCandidate,
    RetrievalCandidate,
    RetrievalMode,
    RerankResultItem,
    VectorIndexStats,
    VectorRecord,
    VectorSearchHit,
    VectorStore,
    VectorStoreHit,
    VectorStoreStats,
} from "./domain/retrieval/retrieval-types";
import type { ChatMessage, StreamHandlers } from "./app/chat/chat-types";
import type { IndexedChunk, KnowledgeBaseSyncResult } from "./domain/documents/document-types";
import type { LocalChatMessage } from "./domain/model/model-types";
import type { VaultCoachSettings } from "./app/config/settings-types";

/**
 * RAG 引擎模块。
 *
 * 负责把用户问题转成完整回答链路：query rewrite、候选召回、混合融合、
 * rerank、prompt 构造、模型生成、来源构造和兜底回答。
 * 它不直接管理 Obsidian 视图或磁盘状态，这些由主插件入口负责。
 */

/**
 * 生成回答前准备好的上下文。
 */
interface PreparedAnswer {
    promptMessages: LocalChatMessage[];
    sources: AnswerSource[];
    rerankedCandidates: RerankedCandidate[];
    retrievalModeUsed: RetrievalMode;
    rewriteResult: QueryRewriteResult;
    originalUserText: string;
    noCandidates: boolean;
}

/**
 * 高级 RAG 引擎。
 */
export class AdvancedRagEngine {
    private readonly documentIndex: DocumentIndexReader;
    private readonly vectorStore: VectorStore;
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
        documentIndex: DocumentIndexReader,
        vectorStore: VectorStore,
        getSettings: () => VaultCoachSettings,
        getRuntimeRetrievalMode: () => RetrievalMode,
        getCloudApiKey: () => string | null,
    ) {
        this.documentIndex = documentIndex;
        this.vectorStore = vectorStore;
        this.getSettings = getSettings;
        this.getRuntimeRetrievalMode = getRuntimeRetrievalMode;
        this.client = new LocalModelClient(getSettings, getCloudApiKey);
    }

    /**
     * 获取当前向量索引统计。
     */
    getVectorIndexStats(): VectorIndexStats {
        return { ...this.vectorStats };
    }

    /**
     * 消费 Ollama embedding CPU fallback 标记。
     */
    consumeOllamaEmbeddingCpuFallbackUsed(): boolean {
        return this.client.consumeOllamaEmbeddingCpuFallbackUsed();
    }

    /**
     * 从磁盘快照恢复向量索引状态。
     */
    hydrateVectorStats(vectorStats: VectorIndexStats): void {
        this.vectorStats = { ...vectorStats };
    }

    /**
     * 从 VectorStore 重新读取向量索引统计。
     */
    async refreshVectorStatsFromStore(): Promise<VectorIndexStats> {
        const stats: VectorStoreStats = await this.vectorStore.getStats();
        this.vectorStats = {
            ready: stats.vectorCount > 0,
            vectorCount: stats.vectorCount,
            dimension: stats.dimension,
            lastBuiltAt: stats.lastUpdatedAt,
        };
        return this.getVectorIndexStats();
    }

    /**
     * 全量重建向量索引。
     */
    async rebuildVectorIndex(signal?: AbortSignal): Promise<VectorIndexStats> {
        const settings: VaultCoachSettings = this.getSettings();
        signal?.throwIfAborted();
        await this.vectorStore.clear();
        this.vectorStats = {
            ready: false,
            vectorCount: 0,
            dimension: null,
            lastBuiltAt: null,
        };

        if (!settings.enableVectorRetrieval || this.getActiveEmbeddingModel(settings).length === 0) {
            return this.getVectorIndexStats();
        }

        const chunks: IndexedChunk[] = this.documentIndex.getAllChunks();
        if (chunks.length === 0) {
            return this.getVectorIndexStats();
        }

        const items: VectorRecord[] = await this.buildChunkEmbeddings(chunks, signal);
        signal?.throwIfAborted();
        await this.vectorStore.upsert(items);
        await this.refreshVectorStatsFromStore();

        return this.getVectorIndexStats();
    }

    /**
     * 增量同步向量索引。
     *
     * 删除已移除 chunk 的向量，只为 changedChunks 重新生成 embedding。
     */
    async syncVectorIndex(syncResult: KnowledgeBaseSyncResult, signal?: AbortSignal): Promise<VectorIndexStats> {
        const settings: VaultCoachSettings = this.getSettings();
        signal?.throwIfAborted();

        if (!settings.enableVectorRetrieval || this.getActiveEmbeddingModel(settings).length === 0) {
            await this.vectorStore.clear();
            this.vectorStats = {
                ready: false,
                vectorCount: 0,
                dimension: null,
                lastBuiltAt: null,
            };
            return this.getVectorIndexStats();
        }

        if (syncResult.removedChunkIds.length > 0) {
            signal?.throwIfAborted();
            await this.vectorStore.remove(syncResult.removedChunkIds);
        }

        if (syncResult.changedChunks.length > 0) {
            const items: VectorRecord[] = await this.buildChunkEmbeddings(syncResult.changedChunks, signal);
            signal?.throwIfAborted();
            await this.vectorStore.upsert(items);
        }

        await this.refreshVectorStatsFromStore();

        return this.getVectorIndexStats();
    }

    /**
     * 根据设置读取当前 embedding 模型名。
     */
    private getActiveEmbeddingModel(settings: VaultCoachSettings): string {
        return settings.embeddingProvider === "openai-compatible"
            ? settings.cloudEmbeddingModel.trim()
            : settings.embeddingModel.trim();
    }

    /**
     * 非流式回答入口。
     */
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
                text: normalizeObsidianMarkdown(this.buildFallbackMarkdownAnswer(
                    prepared.originalUserText,
                    prepared.rewriteResult,
                    prepared.retrievalModeUsed,
                    prepared.rerankedCandidates,
                )),
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
                text: normalizeObsidianMarkdown(markdownAnswer),
                sources: prepared.sources,
                retrievalModeUsed: prepared.retrievalModeUsed,
                queryRewrite: prepared.rewriteResult,
            };
        } catch (error: unknown) {
            console.error("[VaultCoach] 生成回答失败，将回退到检索结果摘要。", error);

            return {
                text: normalizeObsidianMarkdown(this.buildFallbackMarkdownAnswer(
                    prepared.originalUserText,
                    prepared.rewriteResult,
                    prepared.retrievalModeUsed,
                    prepared.rerankedCandidates,
                )),
                sources: prepared.sources,
                retrievalModeUsed: prepared.retrievalModeUsed,
                queryRewrite: prepared.rewriteResult,
            };
        }
    }

    /**
     * 流式回答入口。
     *
     * UI 可通过 handlers 接收 token，同时方法结束时仍返回完整 AssistantAnswer 供持久化。
     */
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
                text: normalizeObsidianMarkdown(this.buildFallbackMarkdownAnswer(
                    prepared.originalUserText,
                    prepared.rewriteResult,
                    prepared.retrievalModeUsed,
                    prepared.rerankedCandidates,
                )),
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
                text: normalizeObsidianMarkdown(markdownAnswer),
                sources: prepared.sources,
                retrievalModeUsed: prepared.retrievalModeUsed,
                queryRewrite: prepared.rewriteResult,
            };
        } catch (streamError: unknown) {
            if (this.isAbortError(streamError)) {
                throw streamError;
            }

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
                    text: normalizeObsidianMarkdown(markdownAnswer),
                    sources: prepared.sources,
                    retrievalModeUsed: prepared.retrievalModeUsed,
                    queryRewrite: prepared.rewriteResult,
                };
            } catch (error: unknown) {
                console.error("[VaultCoach] 非流式回退也失败，将回退到检索结果摘要。", error);
                handlers?.onError?.(error);

                return {
                    text: normalizeObsidianMarkdown(this.buildFallbackMarkdownAnswer(
                        prepared.originalUserText,
                        prepared.rewriteResult,
                        prepared.retrievalModeUsed,
                        prepared.rerankedCandidates,
                    )),
                    sources: prepared.sources,
                    retrievalModeUsed: prepared.retrievalModeUsed,
                    queryRewrite: prepared.rewriteResult,
                };
            }
        }
    }

    /**
     * 识别 AbortError，避免取消操作进入普通失败 fallback。
     */
    private isAbortError(error: unknown): boolean {
        if (error instanceof DOMException) {
            return error.name === "AbortError";
        }

        if (error instanceof Error) {
            return error.name === "AbortError" || /aborted|aborterror/i.test(error.message);
        }

        return false;
    }

    /**
     * 对外暴露长期记忆抽取入口。
     *
     * 主插件负责持久化与去重，本方法只负责调用模型提取候选记忆。
     */
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

    /**
     * 准备回答所需的检索结果、来源和模型消息。
     */
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
        const answerLanguage: QuestionLanguage = detectQuestionLanguage(userText);
        const sources: AnswerSource[] = this.buildAnswerSources(rerankedCandidates, answerLanguage);
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

    /**
     * 根据运行时模式和向量索引状态决定实际检索模式。
     */
    private resolveEffectiveRetrievalMode(): RetrievalMode {
        const runtimeMode: RetrievalMode = this.getRuntimeRetrievalMode();
        const settings: VaultCoachSettings = this.getSettings();

        if (runtimeMode === "keyword") {
            return "keyword";
        }

        if (!settings.enableVectorRetrieval || !this.vectorStats.ready) {
            return "keyword";
        }

        return runtimeMode;
    }

    /**
     * 按检索模式召回候选 chunk。
     */
    private async retrieveCandidates(query: string, mode: RetrievalMode): Promise<RetrievalCandidate[]> {
        if (mode === "keyword") {
            return this.buildCandidatesFromKeywordHits(
                this.documentIndex.searchKeyword(query, this.getSettings().keywordSearchTopK),
            );
        }

        if (mode === "vector") {
            try {
                const vectorHits: VectorSearchHit[] = await this.searchVector(query);
                return this.buildCandidatesFromVectorHits(vectorHits);
            } catch (error: unknown) {
                console.error("[VaultCoach] 向量检索失败，将回退到关键词检索。", error);
                return this.buildCandidatesFromKeywordHits(
                    this.documentIndex.searchKeyword(query, this.getSettings().keywordSearchTopK),
                );
            }
        }

        const keywordHits: KeywordSearchHit[] = this.documentIndex.searchKeyword(query, this.getSettings().keywordSearchTopK);
        let vectorHits: VectorSearchHit[] = [];
        try {
            vectorHits = await this.searchVector(query);
        } catch (error: unknown) {
            console.error("[VaultCoach] 混合检索中的向量召回失败，将只使用关键词召回。", error);
        }
        return this.mergeHybrid(keywordHits, vectorHits, this.getSettings().hybridSearchTopK);
    }

    /**
     * 执行向量召回。
     */
    private async searchVector(query: string): Promise<VectorSearchHit[]> {
        const queryEmbeddings: number[][] = await this.client.embedTexts([query]);
        const queryEmbedding: number[] | undefined = queryEmbeddings[0];
        if (!queryEmbedding) {
            return [];
        }

        const vectorHits: VectorStoreHit[] = await this.vectorStore.search(
            new Float32Array(queryEmbedding),
            { topK: this.getSettings().vectorSearchTopK },
        );
        const chunksById: Map<string, IndexedChunk> = new Map<string, IndexedChunk>(
            this.documentIndex.getChunksByIds(vectorHits.map((hit: VectorStoreHit) => hit.chunkId))
                .map((chunk: IndexedChunk) => [chunk.id, chunk]),
        );

        return vectorHits
            .map((hit: VectorStoreHit) => {
                const chunk: IndexedChunk | undefined = chunksById.get(hit.chunkId);
                if (!chunk) {
                    return null;
                }

                return {
                    chunk,
                    score: hit.score,
                    similarity: hit.similarity,
                };
            })
            .filter((hit: VectorSearchHit | null): hit is VectorSearchHit => hit !== null);
    }

    /**
     * 将关键词命中转换为统一候选结构。
     */
    private buildCandidatesFromKeywordHits(hits: KeywordSearchHit[]): RetrievalCandidate[] {
        return hits.map((hit: KeywordSearchHit) => ({
            chunk: hit.chunk,
            score: hit.score,
            matchedTokens: hit.matchedTokens,
            retrievalChannels: ["keyword"],
            keywordScore: hit.score,
        }));
    }

    /**
     * 将向量命中转换为统一候选结构。
     */
    private buildCandidatesFromVectorHits(hits: VectorSearchHit[]): RetrievalCandidate[] {
        return hits.map((hit: VectorSearchHit) => ({
            chunk: hit.chunk,
            score: hit.score,
            matchedTokens: [],
            retrievalChannels: ["vector"],
            vectorScore: hit.similarity,
        }));
    }

    /**
     * 使用 RRF 融合关键词和向量召回结果。
     */
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

    /**
     * 对召回候选进行重排。
     */
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

    /**
     * 调用独立 rerank 服务进行重排。
     */
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

    /**
     * 本地启发式 rerank fallback。
     */
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

    /**
     * 构造最终回答使用的聊天消息。
     */
    private buildAnswerMessages(
        userText: string,
        rewriteResult: QueryRewriteResult,
        conversationMessages: ChatMessage[],
        contextCandidates: RerankedCandidate[],
        scopeDescription: string,
        memoryContext: string,
    ): LocalChatMessage[] {
        const answerLanguage: QuestionLanguage = detectQuestionLanguage(userText);
        const systemPrompt: string = this.buildAnswerSystemPrompt(answerLanguage);
        const userPrompt: string = this.buildAnswerUserPrompt(
            userText,
            rewriteResult,
            conversationMessages,
            contextCandidates,
            scopeDescription,
            memoryContext,
            answerLanguage,
        );

        return [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ];
    }

    /**
     * 构造回答系统提示词。
     */
    private buildAnswerSystemPrompt(answerLanguage: QuestionLanguage): string {
        if (answerLanguage === "en") {
            return [
                "You are a local knowledge-base assistant running inside Obsidian.",
                "Your answer must be strictly grounded in the provided retrieval context. Do not invent facts that are not present in the knowledge base context.",
                "Answer requirements:",
                "1. Answer in English because the current user question is in English. Ignore the Obsidian UI language, retrieval query language, context language, and memory language when choosing the answer language.",
                "2. Use Markdown to organize the answer.",
                "3. Give the direct conclusion first, then add necessary explanation.",
                "4. If the context is not sufficient, explicitly say: \"Based on the current knowledge-base snippets, there is not enough information.\"",
                "5. Do not fabricate source numbers in the body because clickable sources are shown separately below the answer.",
                "6. If the question involves code, configuration, commands, or paths, use Markdown code blocks when appropriate.",
                "7. If the answer includes math formulas, use Obsidian/KaTeX-compatible syntax: inline math uses `$...$`, block math uses standalone `$$` fences; do not wrap formulas with standalone `[` and `]` or `\\[` and `\\]`.",
            ].join("\n");
        }

        return [
            "你是一个运行在 Obsidian 中的本地知识库助手。",
            "你的回答必须严格基于给定的检索上下文，不能虚构知识库中不存在的事实。",
            "回答要求：",
            "1. 使用中文回答，因为用户当前问题是中文。不要因为 Obsidian 界面语言、检索查询语言、上下文语言或长期记忆语言而改变回答语言。",
            "2. 使用 Markdown 格式组织内容；",
            "3. 优先给出直接结论，再给出必要解释；",
            "4. 如果上下文不足以支撑结论，必须明确说明“根据当前知识库片段，信息不足”；",
            "5. 不要在正文中伪造来源编号，因为插件会在回答下方单独展示可点击来源。",
            "6. 如果问题涉及代码、配置、命令或路径，请尽量使用 Markdown 代码块。",
            "7. 如果回答包含数学公式，必须使用 Obsidian/KaTeX 兼容语法：行内公式使用 `$...$`，块级公式使用独立成行的 `$$` 包裹；不要使用单独的 `[`、`]` 或 `\\[`、`\\]` 包裹公式。",
        ].join("\n");
    }

    /**
     * 构造回答用户提示词。
     */
    private buildAnswerUserPrompt(
        userText: string,
        rewriteResult: QueryRewriteResult,
        conversationMessages: ChatMessage[],
        contextCandidates: RerankedCandidate[],
        scopeDescription: string,
        memoryContext: string,
        answerLanguage: QuestionLanguage,
    ): string {
        if (answerLanguage === "en") {
            return [
                "Final answer language: English. This is determined only by the current user question.",
                `Knowledge base scope: ${scopeDescription}`,
                `Original question: ${userText}`,
                `Retrieval query: ${rewriteResult.rewrittenQuery}`,
                "",
                "Long-term memory (only a small amount relevant to the current question):",
                memoryContext || "(No relevant long-term memory)",
                "",
                "Recent conversation (only a small amount, used to resolve references):",
                this.buildConversationContext(conversationMessages) || "(None)",
                "",
                "Retrieved context:",
                this.buildContextBlock(contextCandidates, answerLanguage),
                "",
                "Answer the user's question based on the context above and keep the structure clear.",
            ].join("\n");
        }

        return [
            "最终回答语言：中文。这个判断只由用户当前问题决定。",
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
            this.buildContextBlock(contextCandidates, answerLanguage),
            "",
            "请基于以上上下文回答用户问题，并保持结构清晰。",
        ].join("\n");
    }

    /**
     * 构造注入 prompt 的检索上下文块。
     */
    private buildContextBlock(contextCandidates: RerankedCandidate[], answerLanguage: QuestionLanguage): string {
        const blocks: string[] = [];

        for (let index = 0; index < contextCandidates.length; index += 1) {
            const candidate: RerankedCandidate | undefined = contextCandidates[index];
            if (!candidate) {
                continue;
            }

            const headingLabel: string = candidate.chunk.headingPath.length > 0
                ? candidate.chunk.headingPath.join(" > ")
                : answerLanguage === "en" ? "(No heading)" : "（无标题）";

            if (answerLanguage === "en") {
                blocks.push([
                    `### Context ${index + 1}`,
                    `- File: ${candidate.chunk.filePath}`,
                    `- Heading path: ${headingLabel}`,
                    `- Source location: ${this.formatLocatorLabel(candidate.chunk, answerLanguage)}`,
                    `- Retrieval channels: ${candidate.retrievalChannels.join(", ")}`,
                    "```text",
                    candidate.chunk.text,
                    "```",
                ].join("\n"));
                continue;
            }

            blocks.push([
                `### 上下文 ${index + 1}`,
                `- 文件：${candidate.chunk.filePath}`,
                `- 标题路径：${headingLabel}`,
                `- 来源位置：${this.formatLocatorLabel(candidate.chunk, answerLanguage)}`,
                `- 召回通道：${candidate.retrievalChannels.join(", ")}`,
                "```text",
                candidate.chunk.text,
                "```",
            ].join("\n"));
        }

        return blocks.join("\n\n");
    }

    /**
     * 根据重排结果生成回答下方展示的来源列表。
     */
    private buildAnswerSources(candidates: RerankedCandidate[], answerLanguage: QuestionLanguage): AnswerSource[] {
        const uniqueSources: AnswerSource[] = [];
        const seenKeys: Set<string> = new Set<string>();
        const settings: VaultCoachSettings = this.getSettings();

        for (const candidate of candidates) {
            const source: AnswerSource = this.convertChunkToSource(candidate.chunk, answerLanguage);
            const uniqueKey: string = source.locator?.type === "pdf"
                ? `${source.filePath}::page:${source.pageStart ?? 0}-${source.pageEnd ?? source.pageStart ?? 0}`
                : `${source.filePath}::${source.heading ?? "__root__"}`;

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

    /**
     * 在生成模型不可用或无候选时构造可读的检索摘要。
     */
    private buildFallbackMarkdownAnswer(
        userText: string,
        rewriteResult: QueryRewriteResult,
        retrievalModeUsed: RetrievalMode,
        candidates: RerankedCandidate[],
    ): string {
        const answerLanguage: QuestionLanguage = detectQuestionLanguage(userText);
        if (candidates.length === 0) {
            if (answerLanguage === "en") {
                return [
                    "## No Relevant Content Found",
                    "",
                    `Current retrieval mode: \`${retrievalModeUsed}\`.`,
                    `Retrieval query: ${rewriteResult.rewrittenQuery}`,
                    "",
                    "Try using more specific keywords, or rebuild the index first.",
                ].join("\n");
            }

            return [
                "## 未检索到相关内容",
                "",
                `当前检索模式：\`${retrievalModeUsed}\`。`,
                `检索查询：${rewriteResult.rewrittenQuery}`,
                "",
                "你可以尝试换更具体的关键词，或先手动重建索引。",
            ].join("\n");
        }

        if (answerLanguage === "en") {
            const lines: string[] = [
                "## Retrieval Result Summary",
                "",
                `- Original question: ${userText}`,
                `- Retrieval query: ${rewriteResult.rewrittenQuery}`,
                `- Retrieval mode: \`${retrievalModeUsed}\``,
                "",
                "The local chat model is unavailable, so this is a summary built from the retrieved results:",
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

            lines.push("Check the local chat model URL and model name, or use these retrieval results to locate the relevant notes.");
            return lines.join("\n");
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

    /**
     * 将 chunk 转换为用户可点击的来源结构。
     */
    private convertChunkToSource(chunk: IndexedChunk, answerLanguage: QuestionLanguage): AnswerSource {
        if (chunk.locator.type === "pdf") {
            const pageEnd: number = chunk.locator.pageEnd ?? chunk.locator.pageStart;
            const pageLabel: string = this.formatPdfSourcePageLabel(chunk.locator.pageStart, pageEnd, answerLanguage);

            return {
                filePath: chunk.filePath,
                locator: chunk.locator,
                pageStart: chunk.locator.pageStart,
                pageEnd,
                displayLink: `[[${chunk.filePath}#page=${chunk.locator.pageStart}|${chunk.fileName} · ${pageLabel}]]`,
                excerpt: this.createExcerpt(chunk.text, 180),
            };
        }

        const displayLink: string = chunk.primaryHeading
            ? `[[${chunk.filePath}#${chunk.primaryHeading}]]`
            : `[[${chunk.filePath}]]`;

        return {
            filePath: chunk.filePath,
            locator: chunk.locator,
            heading: chunk.primaryHeading,
            displayLink,
            excerpt: this.createExcerpt(chunk.text, 180),
        };
    }

    /**
     * 格式化 PDF 来源页码。
     */
    private formatPdfSourcePageLabel(pageStart: number, pageEnd: number, answerLanguage: QuestionLanguage): string {
        if (answerLanguage === "en") {
            return pageEnd === pageStart
                ? `page ${pageStart}`
                : `pages ${pageStart}-${pageEnd}`;
        }

        return pageEnd === pageStart
            ? `第 ${pageStart} 页`
            : `第 ${pageStart}-${pageEnd} 页`;
    }

    /**
     * 格式化 prompt 中展示的来源定位。
     */
    private formatLocatorLabel(chunk: IndexedChunk, answerLanguage: QuestionLanguage): string {
        if (chunk.locator.type === "pdf") {
            const pageEnd: number = chunk.locator.pageEnd ?? chunk.locator.pageStart;
            if (answerLanguage === "en") {
                return pageEnd === chunk.locator.pageStart
                    ? `PDF page ${chunk.locator.pageStart}`
                    : `PDF pages ${chunk.locator.pageStart}-${pageEnd}`;
            }

            return pageEnd === chunk.locator.pageStart
                ? `PDF 第 ${chunk.locator.pageStart} 页`
                : `PDF 第 ${chunk.locator.pageStart}-${pageEnd} 页`;
        }

        return chunk.primaryHeading ?? (answerLanguage === "en" ? "(No heading)" : "（无标题）");
    }

    /**
     * 构造 rerank 服务使用的文档文本。
     */
    private buildRerankDocument(chunk: IndexedChunk): string {
        return [
            `文件：${chunk.filePath}`,
            `标题：${chunk.headingPath.join(" > ") || "（无标题）"}`,
            "",
            chunk.text,
        ].join("\n");
    }

    /**
     * 构造最近对话上下文。
     */
    private buildConversationContext(messages: ChatMessage[]): string {
        const recentMessages: ChatMessage[] = messages.slice(-6);
        const lines: string[] = [];

        for (const message of recentMessages) {
            const roleLabel: string = message.role === "user" ? "用户" : "助手";
            lines.push(`${roleLabel}：${message.text.replace(/\s+/g, " ").trim()}`);
        }

        return lines.join("\n");
    }

    /**
     * 构造用户可读摘录。
     */
    private createExcerpt(text: string, maxLength: number): string {
        const normalizedText: string = text.replace(/\s+/g, " ").trim();
        if (normalizedText.length <= maxLength) {
            return normalizedText;
        }

        return `${normalizedText.slice(0, maxLength)}…`;
    }

    /**
     * 轻量 tokenizer，支持中英文混合检索。
     */
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

    /**
     * 用于短语匹配的文本归一化。
     */
    private normalizeForPhraseMatch(text: string): string {
        return text.toLowerCase().replace(/\s+/g, " ").trim();
    }

    /**
     * 分批为 chunk 生成 embedding 记录。
     */
    private async buildChunkEmbeddings(chunks: IndexedChunk[], signal?: AbortSignal): Promise<VectorRecord[]> {
        const batchSize = 16;
        const items: VectorRecord[] = [];

        for (let start = 0; start < chunks.length; start += batchSize) {
            signal?.throwIfAborted();
            const batchChunks: IndexedChunk[] = chunks.slice(start, start + batchSize);
            const batchTexts: string[] = batchChunks.map((chunk: IndexedChunk) => chunk.searchableText);
            const embeddings: number[][] = await this.client.embedTexts(batchTexts);
            signal?.throwIfAborted();

            const pairCount: number = Math.min(batchChunks.length, embeddings.length);
            for (let index = 0; index < pairCount; index += 1) {
                const chunk: IndexedChunk | undefined = batchChunks[index];
                const vector: number[] | undefined = embeddings[index];

                if (chunk && vector) {
                    const pageStart: number | undefined = chunk.locator.type === "pdf" ? chunk.locator.pageStart : undefined;
                    const pageEnd: number | undefined = chunk.locator.type === "pdf" ? chunk.locator.pageEnd : undefined;
                    items.push({
                        chunkId: chunk.id,
                        vector: new Float32Array(vector),
                        metadata: {
                            documentId: chunk.documentId,
                            documentType: chunk.documentType,
                            filePath: chunk.filePath,
                            pageStart,
                            pageEnd,
                        },
                    });
                }
            }
        }

        return items;
    }
}
