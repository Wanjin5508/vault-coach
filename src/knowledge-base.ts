import { App, TFile, normalizePath } from "obsidian";
import type {
    IndexedChunk,
    KeywordSearchHit,
    KnowledgeBaseStats,
    VaultCoachSettings,
} from "./types";

/**
 * 内部使用的 section 结构
 * 一个 section 对应一个md 文件中某个 heading 下的正位片段
 */
interface Section {
    headingPath: string[];
    text: string;
}

/**
 * VaultKnowledgeBase 负责整个“非 LLM 检索骨架”的核心能力：
 * 1. 扫描 vault / 指定目录中的 Markdown 文件
 * 2. 按 Markdown 标题结构切分文本
 * 3. 构建倒排索引（inverted index）
 * 4. 提供关键词检索接口
 *
 * 这样做的好处是：
 * - main.ts 只负责插件生命周期与状态调度
 * - view.ts 只负责界面展示
 * - 检索逻辑集中在一个独立类中，后续接入向量检索时更容易扩展
 */
export class VaultKnowledgeBase {
    private readonly app: App;
    private readonly getSettings: () => VaultCoachSettings;  // ? 这什么类型？

    // 索引后的 chunk 列表
    private chunks: IndexedChunk[] = [];

    // 通过 chunkId 快速获取 chunk的映射表
    private readonly chunkMap: Map<string, IndexedChunk> = new Map<string, IndexedChunk>();

    /**
     * 倒排索引：
     * token -> (chunkId -> tf)
     *
     * 其中 tf（term frequency）表示该 token 在某个 chunk 中出现了多少次。
     */
    private readonly invertedIndex: Map<string, Map<string, number>> = new Map<string, Map<string, number>>();

    // 当前索引的统计信息
    private stats: KnowledgeBaseStats = {
        fileCount: 0,
        chunkCount: 0,
        lastIndexedAt: null,
        scopeDescription: "尚未建立索引。"
    }

    constructor(app: App, getSettings: () => VaultCoachSettings) {
        this.app = app;
        this.getSettings = getSettings;
    }

    /**
     * 当前是否已经至少建立过一次索引。
     */
    isReady(): boolean {
        return this.stats.lastIndexedAt !== null;
    }

    /**
     * 获取只读的索引统计信息。
     */
    getStats(): KnowledgeBaseStats {
        return {...this.stats}; // ? 什么用法？
    }

    /**
     * 重建整个知识库索引。
     *
     * 注意：这里采用“全量重建”而不是“增量更新”，原因是：
     * 1. 第一阶段先追求结构清晰，便于学习和调试
     * 2. vault 规模通常可控，先用全量方案足够稳定
     * 3. 后续如果需要性能优化，再把它升级为增量索引即可
     */
    async rebuildIndex(): Promise<KnowledgeBaseStats> {
        this.clearIndex();

        const targetFiles: TFile[] = this.resolveTargetMarkdownFiles();
        const settings: VaultCoachSettings = this.getSettings();

        for (const file of targetFiles) { 
            const fileContent: string = await this.app.vault.cachedRead(file);
            const fileChunks: IndexedChunk[] = this.chunkMarkdownFile(
                file, 
                fileContent,
                settings.chunkSize,
                settings.chunkOverlap,
            );

        }

        this.stats = {
            fileCount: targetFiles.length,
            chunkCount: this.chunks.length,
            lastIndexedAt: Date.now(),
            scopeDescription: this.describeCurrentScope(),
        };

        return this.getStats()
    }

    /**
     * 对外提供的关键词检索接口。
     *
     * 这里不是简单的 “includes 判断”，而是做了一个适合第一阶段使用的轻量级打分：
     * - token 命中次数（tf）
     * - token 逆文档频率（idf）
     * - 完整短语命中加分
     * - 标题命中加分
     */
    search(query: string, limit: number): KeywordSearchHit[] {
        const trimmedQuery: string = query.trim();
        if (!trimmedQuery) {
            return [];
        }

        const uniqueQueryTokens: string[] = Array.from(new Set(this.tokenize(trimmedQuery)));
        if (uniqueQueryTokens.length === 0) {
            return [];
        }

        const scoreMap: Map<string, number> = new Map<string, number>();  // ? 初始值是什么？
        const matchedTokenMap: Map<string, Set<string>> = new Map<string, Set<string>>();

        // 第一轮，通过倒排索引累计 token 分数, TF-IDF = TF * IDF
        for (const token of uniqueQueryTokens) {
            const postingList: Map<string, number> | undefined = this.invertedIndex.get(token);
            if (!postingList) {
                continue;
            }

            const documentFrequencies: number = postingList.size;
            const inverseDocumentFrequency: number = Math.log((this.chunks.length + 1) / (documentFrequencies + 1)) + 1; // IDF

            for (const [chunkId, termFrequency] of postingList.entries()) {
                const previousScore: number = scoreMap.get(chunkId) ?? 0;
                scoreMap.set(chunkId, previousScore + termFrequency * inverseDocumentFrequency)

                const tokenSet: Set<string> = matchedTokenMap.get(chunkId) ?? new Set<string>();
                tokenSet.add(token);
                matchedTokenMap.set(chunkId, tokenSet);
            }

        }

        // 第二轮，增加短语命中与标题命中加分
        const normalizedQuery: string = this.normalizeForPhraseMatch(trimmedQuery);
        const hits: KeywordSearchHit[] = [];

        for (const [chunkId, baseScore] of scoreMap.entries()) {
            const chunk: IndexedChunk | undefined = this.chunkMap.get(chunkId);
            if (!chunk) { 
                continue;
            }

            let finalScore: number = baseScore;
            const normalizedChunkText: string = this.normalizeForPhraseMatch(chunk.searchableText);
            const normalizedHeadingText: string = this.normalizeForPhraseMatch(chunk.headingPath.join(" "));

            if (normalizedQuery.length > 0 && normalizedChunkText.includes(normalizedQuery)) {
                // 完整短语命中，说明 query 作为一个连续片段出现过，相关性通常更高
                finalScore += 3;
            }

            if (normalizedQuery.length > 0 && normalizedHeadingText.includes(normalizedQuery)) {
                // 如果用户问题中的短语直接落在标题里，额外给加分
                finalScore += 2;
            }

            const matchedTokens: string[] = Array.from(matchedTokenMap.get(chunkId) ?? []);

            // 如果一个 chunk 命中了更多不同的 token，说明覆盖度更高，也应该适当加分
            finalScore += matchedTokens.length * 0.3;

            hits.push({
                chunk,
                score: finalScore,
                matchedTokens,
            });
        }

        hits.sort((left: KeywordSearchHit, right: KeywordSearchHit) => right.score - left.score);
        return hits.slice(0, limit);

    }
    

}





