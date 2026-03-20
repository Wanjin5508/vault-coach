import { DEFAULT_RRF_K } from "./constants";
import { VaultKnowledgeBase } from "./knowledge-base";
import { LocalModelClient } from "./model-client";
import type {
    AnswerSource,
    AssistantAnswer,
    ChatMessage,
    ChunkEmbedding,
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
    ) {
        this.knowledgeBase = knowledgeBase;
        this.getSettings = getSettings;
        this.getRuntimeRetrievalMode = getRuntimeRetrievalMode;
        this.client = new LocalModelClient(getSettings);
    }

    getVectorIndexStats(): VectorIndexStats {
        return { ...this.vectorStats };
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

        if (!settings.enableVectorRetrieval || settings.embeddingModel.trim().length === 0) {
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

        if (!settings.enableVectorRetrieval || settings.embeddingModel.trim().length === 0) {
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
            const vectorHits: VectorSearchHit[] = await this.searchVector(query);
            return this.buildCandidatesFromVectorHits(vectorHits);
        }

        const keywordHits: KeywordSearchHit[] = this.knowledgeBase.searchKeyword(query, this.getSettings().keywordSearchTopK);
        const vectorHits: VectorSearchHit[] = await this.searchVector(query);
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