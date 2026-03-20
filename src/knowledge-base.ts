import { App, TFile, normalizePath } from "obsidian";
import type {
    ChunkEmbedding,
    IndexedChunk,
    KnowledgeBaseFileRecord,
    KnowledgeBaseSnapshot,
    KnowledgeBaseStats,
    KnowledgeBaseSyncResult,
    KeywordSearchHit,
    VectorSearchHit,
    VaultCoachSettings,
} from "./types";

/**
 * 内部使用的 section 结构
 * 一个 section 对应一个md 文件中某个 heading 下的正位片段
 */
interface MarkdownSection {
    headingPath: string[];
    text: string;
}

/**
 * VaultKnowledgeBase 负责第一阶段与第二阶段共享的“知识库底座”：
 * 1. 扫描 vault / 指定目录中的 Markdown 文件
 * 2. 对 Markdown 文本进行 heading-aware chunking
 * 3. 建立倒排索引用于关键词检索
 * 4. 保存向量索引并提供向量检索接口
 *
 * 设计原则：
 * - 它不直接关心 LLM 生成回答；
 * - 它只负责“把 Markdown 变成可检索的数据结构”。
 */
export class VaultKnowledgeBase {
    private readonly app: App;
    private readonly getSettings: () => VaultCoachSettings;  // ? 这什么类型？

    /**
     * 所有 chunk 的顺序数组。
     * 顺序数组适合做遍历、批量 embedding 和统计。
     */
    private chunks: IndexedChunk[] = [];

    /**
     * chunkId -> chunk 的哈希映射。
     * 适合在检索结果回填时快速定位 chunk。
     */
    private readonly chunkMap: Map<string, IndexedChunk> = new Map<string, IndexedChunk>();

    /**
     * 轻量级倒排索引：token -> (chunkId -> termFrequency)
     *其中 tf（term frequency）表示该 token 在某个 chunk 中出现了多少次。
     * 例如：
     * "rag" -> {
     *   "fileA::heading::0" => 3,
     *   "fileB::heading::2" => 1,
     * }
     */
    private readonly invertedIndex: Map<string, Map<string, number>> = new Map<string, Map<string, number>>();

    /**
     * 向量索引：chunkId -> L2 归一化后的 embedding 向量。
     *
     * 之所以存“归一化后的向量”，是因为这样做余弦相似度时只需要点积，
     * 可以避免每次查询都重复计算范数。
     */
    private readonly embeddingMap: Map<string, number[]> = new Map<string, number[]>();

    private readonly fileChunkIds: Map<string, string[]> = new Map<string, string[]>();
    private readonly fileHashes: Map<string, string> = new Map<string, string>();

    // 当前索引的统计信息
    private stats: KnowledgeBaseStats = {
        fileCount: 0,
        chunkCount: 0,
        lastIndexedAt: null,
        scopeDescription: "整个 Vault"
    }

    constructor(app: App, getSettings: () => VaultCoachSettings) {
        this.app = app;
        this.getSettings = getSettings;
    }

    /**
     * 当前索引是否已经准备好。
     * 这里的“准备好”只表示文本索引存在，并不强制要求向量索引也已建立。
     */
    isReady(): boolean {
        return this.stats.lastIndexedAt !== null && this.chunks.length > 0;
    }

    /**
     * 获取只读的索引统计信息。
     */
    getStats(): KnowledgeBaseStats {
        return { 
            ...this.stats 
        }; // ? 什么用法？
    }

    /**
     * 获取全部 chunk。
     * 第二阶段建立 embedding 时会用到这个方法。
     */
    getAllChunks(): IndexedChunk[] {
        return [...this.chunks];
    }

    getEmbeddingSnapshot(): ChunkEmbedding[] {
        return Array.from(this.embeddingMap.entries()).map(([chunkId, vector]) => ({
            chunkId,
            vector: [...vector],
        }));
    }

    getFileRecords(): KnowledgeBaseFileRecord[] {
        return Array.from(this.fileChunkIds.entries()).map(([filePath, chunkIds]) => ({
            filePath,
            contentHash: this.fileHashes.get(filePath) ?? "",
            chunkIds: [...chunkIds],
            indexedAt: this.stats.lastIndexedAt ?? Date.now(),
        }));
    }

    getSettingsSignature(): string {
        const settings: VaultCoachSettings = this.getSettings();
        return JSON.stringify({
            knowledgeScopeMode: settings.knowledgeScopeMode,
            knowledgeFolder: this.normalizeFolderPath(settings.knowledgeFolder),
            chunkSize: settings.chunkSize,
            chunkOverlap: settings.chunkOverlap,
        });
    }

    /**
     * 当前是否已经拥有向量索引。
     */
    hasVectorIndex(): boolean {
        return this.embeddingMap.size > 0;
    }

    /**
     * 清空现有的向量索引。
     * 当文本索引重建后，旧向量已经不再可信，因此应一并清空。
     */
    clearVectorIndex(): void {
        this.embeddingMap.clear();
    }

    /**
     * 批量写入 chunk 向量。
     * 上层 RAG 引擎会在拿到 embedding 结果后调用这个方法。
     */
    setEmbeddings(items: ChunkEmbedding[]): void {
        this.embeddingMap.clear();

        this.upsertEmbeddings(items);
    }

    upsertEmbeddings(items: ChunkEmbedding[]): void {
        for (const item of items) {
            const normalizedVector: number[] = this.normalizeVector(item.vector);
            if (normalizedVector.length > 0) {
                this.embeddingMap.set(item.chunkId, normalizedVector);
            }
        }
    }

    removeEmbeddings(chunkIds: string[]): void {
        for (const chunkId of chunkIds) {
            this.embeddingMap.delete(chunkId);
        }
    }

    /**
     * 从磁盘快照恢复文本索引、文件级元数据与向量索引
     */
    loadFromSnapshot(snapshot: Pick<KnowledgeBaseSnapshot, "stats" | "chunks" | "files" | "embeddings">): void {
        this.clearIndex();

        for (const record of snapshot.files) {
            this.fileChunkIds.set(record.filePath, [...record.chunkIds]);
            this.fileHashes.set(record.filePath, record.contentHash);
        }

        for (const chunk of snapshot.chunks) {
            this.addChunkToIndex(chunk);
        }

        this.upsertEmbeddings(snapshot.embeddings);
        this.stats = {
            ...snapshot.stats,
            scopeDescription: this.describeCurrentScope(),
        };
        this.rebuildChunkArray();
    }

    /**
     * 重建整个知识库索引。
     *
     * 注意：这里采用“全量重建”而不是“增量更新”，原因是：
     * 1. 第一阶段先追求结构清晰，便于学习和调试
     * 2. vault 规模通常可控，先用全量方案足够稳定
     * 3. 后续如果需要性能优化，再把它升级为增量索引即可
     *  * 注意：
     * - 这里只负责扫描、切块和倒排索引；
     * - 向量索引由上层额外建立，因为向量索引依赖外部 embedding 模型。
     */
    async rebuildIndex(): Promise<KnowledgeBaseStats> {
        const result: KnowledgeBaseSyncResult = await this.rebuildIndexDetailed();
        return result.stats;
    }

    // 新增：全量重建时返回详细变更结果，供向量层同步。
    async rebuildIndexDetailed(): Promise<KnowledgeBaseSyncResult> {
        this.clearIndex();

        const targetFiles: TFile[] = this.resolveTargetMarkdownFiles();
        const settings: VaultCoachSettings = this.getSettings();
        const changedChunks: IndexedChunk[] = [];

        for (const file of targetFiles) {
            const fileContent: string = await this.app.vault.cachedRead(file);
            const contentHash: string = this.hashContent(fileContent);
            const fileChunks: IndexedChunk[] = this.chunkMarkdownFile(
                file,
                fileContent,
                settings.chunkSize,
                settings.chunkOverlap,
            );

            this.fileChunkIds.set(file.path, fileChunks.map((chunk: IndexedChunk) => chunk.id));
            this.fileHashes.set(file.path, contentHash);

            for (const chunk of fileChunks) {
                this.addChunkToIndex(chunk);
                changedChunks.push(chunk);
            }
        }

        this.updateStats(targetFiles.length);
        return {
            stats: this.getStats(),
            changedChunks,
            removedChunkIds: [],
            affectedFiles: targetFiles.map((file: TFile) => file.path),
        };
    }

    // 新增：只同步发生改动的 Markdown 文件。
    async syncChangedFiles(filePaths: string[]): Promise<KnowledgeBaseSyncResult> {
        const dedupedPaths: string[] = Array.from(
            new Set(
                filePaths
                    .map((path: string) => path.trim())
                    .filter((path: string) => path.length > 0 && this.isMarkdownPath(path)),
            ),
        );

        if (dedupedPaths.length === 0) {
            return {
                stats: this.getStats(),
                changedChunks: [],
                removedChunkIds: [],
                affectedFiles: [],
            };
        }

        const settings: VaultCoachSettings = this.getSettings();
        const currentFiles: Map<string, TFile> = new Map<string, TFile>();
        const targetFiles: TFile[] = this.resolveTargetMarkdownFiles();
        for (const file of targetFiles) {
            currentFiles.set(file.path, file);
        }

        const changedChunks: IndexedChunk[] = [];
        const removedChunkIds: string[] = [];

        for (const filePath of dedupedPaths) {
            const existingFile: TFile | undefined = currentFiles.get(filePath);

            if (!existingFile) {
                removedChunkIds.push(...this.removeFileFromIndex(filePath));
                continue;
            }

            const fileContent: string = await this.app.vault.cachedRead(existingFile);
            const contentHash: string = this.hashContent(fileContent);
            const previousHash: string | undefined = this.fileHashes.get(filePath);

            if (previousHash === contentHash) {
                continue;
            }

            removedChunkIds.push(...this.removeFileFromIndex(filePath));

            const fileChunks: IndexedChunk[] = this.chunkMarkdownFile(
                existingFile,
                fileContent,
                settings.chunkSize,
                settings.chunkOverlap,
            );

            this.fileChunkIds.set(existingFile.path, fileChunks.map((chunk: IndexedChunk) => chunk.id));
            this.fileHashes.set(existingFile.path, contentHash);

            for (const chunk of fileChunks) {
                this.addChunkToIndex(chunk);
                changedChunks.push(chunk);
            }
        }

        this.updateStats(targetFiles.length);
        return {
            stats: this.getStats(),
            changedChunks,
            removedChunkIds,
            affectedFiles: dedupedPaths,
        };
    }

    /**
     * 对外提供的关键词检索接口。
     *
     * 这里不是简单的 “includes 判断”，而是做了一个适合第一阶段使用的轻量级打分：
     *   - token 命中次数（tf）
     *   - token 逆文档频率（idf）
     * * - 完整短语命中加分
     * * - 标题命中加分
     */
    searchKeyword(query: string, limit: number): KeywordSearchHit[] {
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

    /**
     * 对外提供的向量检索接口。
     *
     * 输入要求：
     * - queryEmbedding 必须已经是“与 chunk embedding 同维度”的向量；
     * - 如果调用者没有事先归一化，也没有关系，这里会再做一次 L2 归一化。
     */
    searchVector(queryEmbedding: number[], limit: number): VectorSearchHit[] {
        if (this.embeddingMap.size === 0) {
            return [];
        }

        const normalizeQueryVector: number[] = this.normalizeVector(queryEmbedding);
        if (normalizeQueryVector.length === 0) {
            return [];
        }

        const hits: VectorSearchHit[] = [];

        for (const [chunkId, chunkVector] of this.embeddingMap.entries()) {
            const chunk: IndexedChunk | undefined = this.chunkMap.get(chunkId);
            if (!chunk) {
                continue;
            }

            const similarity: number = this.dot(normalizeQueryVector, chunkVector);
            hits.push({
                chunk,
                score: similarity,
                similarity,
            });
        }

        hits.sort((left: VectorSearchHit, right: VectorSearchHit) => right.score - left.score);
        return hits.slice(0, limit);
    } 

    /**
     * 清空现有索引数据
     * 
     */
    private clearIndex(): void {
        this.chunks = [];
        this.chunkMap.clear();
        this.invertedIndex.clear();
        this.embeddingMap.clear();
        this.fileChunkIds.clear();
        this.fileHashes.clear();
        this.stats = {
            fileCount: 0,
            chunkCount: 0,
            lastIndexedAt: null,
            scopeDescription: this.describeCurrentScope(),
        };

    }

    private updateStats(fileCount: number): void {
        this.rebuildChunkArray();
        this.stats = {
            fileCount,
            chunkCount: this.chunks.length,
            lastIndexedAt: Date.now(),
            scopeDescription: this.describeCurrentScope(),
        };
    }

    private removeFileFromIndex(filePath: string): string[] {
        const chunkIds: string[] = this.fileChunkIds.get(filePath) ?? [];
        for (const chunkId of chunkIds) {
            const chunk: IndexedChunk | undefined = this.chunkMap.get(chunkId);
            if (!chunk) {
                continue;
            }

            const tokens: string[] = Array.from(new Set(this.tokenize(chunk.searchableText)));
            for (const token of tokens) {
                const postingList: Map<string, number> | undefined = this.invertedIndex.get(token);
                if (!postingList) {
                    continue;
                }

                postingList.delete(chunkId);
                if (postingList.size === 0) {
                    this.invertedIndex.delete(token);
                }
            }

            this.chunkMap.delete(chunkId);
            this.embeddingMap.delete(chunkId);
        }

        this.fileChunkIds.delete(filePath);
        this.fileHashes.delete(filePath);
        this.rebuildChunkArray();
        return chunkIds;
    }

    private rebuildChunkArray(): void {
        this.chunks = Array.from(this.chunkMap.values()).sort((left: IndexedChunk, right: IndexedChunk) => {
            const fileOrder: number = left.filePath.localeCompare(right.filePath);
            return fileOrder !== 0 ? fileOrder : left.id.localeCompare(right.id);
        });
    }

    /**
     * 根据设置解析当前应该纳入索引的 Markdown 文件。
     */
    private resolveTargetMarkdownFiles(): TFile[] {
        const settings: VaultCoachSettings = this.getSettings();
        const allMarkdownFiles: TFile[] = this.app.vault.getMarkdownFiles();

        if (settings.knowledgeScopeMode === "wholeVault") {
            return allMarkdownFiles;
        }

        const normalizedFolder: string = this.normalizeFolderPath(settings.knowledgeFolder);
        if (!normalizedFolder) {
            return [];
        }

        const folderPrefix: string = normalizedFolder.endsWith("/")
            ? normalizedFolder
            : `${normalizedFolder}/`

        return allMarkdownFiles.filter((file: TFile) => file.path.startsWith(folderPrefix));
    }

    /**
     * 将单个 Markdown 文件切分为多个 chunk。
     *
     * 核心思路：
     * 1. 先按 heading 分 section
     * 2. 再在 section 内按自然段聚合
     * 3. 超长内容再做字符级切分
     *
     * 这样生成的 chunk 更符合 Obsidian 笔记的结构特征，
     * 也更利于后续做 heading 级跳转。
     */
    private chunkMarkdownFile(
        file: TFile,
        content: string,
        chunkSize: number,
        chunkOverlap: number,
    ): IndexedChunk[] {
        const sections: MarkdownSection[] = this.parseMarkdownSections(content);
        const chunks: IndexedChunk[] = [];

        if (sections.length === 0) {
            return chunks;
        }

        let chunkSerial: number = 0;

        for (const section of sections) {
            const sectionChunks: string[] = this.splitSectionTextIntoChunkTexts(
                section.text,
                chunkSize,
                chunkOverlap,
            );

            for (const chunkText of sectionChunks) {
                const primaryHeading: string | undefined = section.headingPath[section.headingPath.length - 1];
                const searchableTextParts: string[] = [
                    file.basename,
                    ...section.headingPath,
                    chunkText,
                ];

                const searchableText: string = searchableTextParts.join("\n").trim();
                const chunkId: string = `${file.path}::${primaryHeading ?? "__root__"}::${chunkSerial} `;

                chunks.push({
                    id: chunkId,
                    filePath: file.path,
                    fileName: file.name,
                    headingPath: [...section.headingPath],
                    primaryHeading,
                    text: chunkText,
                    searchableText,
                });

                chunkSerial += 1;

            }
        }
        return chunks;
    }

    /**
     * 将 chunk 写入倒排索引
     */
    private addChunkToIndex(chunk: IndexedChunk): void {
        // this.chunks.push(chunk);
        this.chunkMap.set(chunk.id, chunk);

        const tokens: string[] = this.tokenize(chunk.searchableText);
        const termFrequencyMap: Map<string, number> = new Map<string, number>();

        for (const token of tokens) {
            const previousCount: number = termFrequencyMap.get(token) ?? 0;
            termFrequencyMap.set(token, previousCount + 1);
        }

        for (const [token, termFrequency] of termFrequencyMap.entries()) {
            const postingList: Map<string, number> = this.invertedIndex.get(token) ?? new Map<string, number>();
            postingList.set(chunk.id, termFrequency);
            this.invertedIndex.set(token, postingList);
        }
    }


    /**
     * 解析 Markdown 标题结构。
     *
     * 示例：
     * ## 检索流程
     * 文本...
     * ### 混合检索
     * 文本...
     *
     * 最终会得到多个 section，每个 section 都保留 headingPath。
     */
    private parseMarkdownSections(content: string): MarkdownSection[] {
        const lines: string[] = content.split(/\r?\n/);
        const sections: MarkdownSection[] = [];
        let currentHeadingPath: string[] = [];
        let buffer: string[] = [];

        const flushBuffer = (): void => {
            const text: string = buffer.join("\n").trim();
            if (text.length > 0) {
                sections.push({
                    headingPath: [...currentHeadingPath],
                    text,
                });
            }
            buffer = [];
        };

        for (const rawLine of lines) {
            const headingMatch: RegExpExecArray | null = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/.exec(rawLine);

            if (headingMatch) {
                flushBuffer();

                const hashes: string | undefined = headingMatch[1];
                const rawHeadingText: string | undefined = headingMatch[2];

                // 在开启 noUncheckedIndexedAccess 时，
                // 即使 headingMatch 不为 null，捕获组也仍然可能被推断为 undefined，
                // 因此这里需要再做一次显式保护。
                if (!hashes || rawHeadingText === undefined) {
                    continue;
                }

                const headingLevel: number = hashes.length;
                const headingText: string = rawHeadingText.trim().replace(/\s+#*\s*$/, "");


                // headingLevel 为 1 表示一级标题，因此要保留 0 个旧层级；
                // headingLevel 为 2 表示二级标题，因此要保留 1 个旧层级，以此类推。
                currentHeadingPath = currentHeadingPath.slice(0, Math.max(headingLevel - 1, 0));
                currentHeadingPath[headingLevel - 1] = headingText;
                continue;
            }

            buffer.push(rawLine);
        }
        flushBuffer();

        // 如果整篇文件既没有标题，也没有正文，就返回空数组。
        return sections;


    }

    /**
     * 将某个 section 的正文进一步切分为多个 chunk 文本。
     *
     * 这里优先按自然段聚合，因为自然段比“纯字符切片”更符合笔记的语义边界。
     */
    private splitSectionTextIntoChunkTexts(
        sectionText: string,
        chunkSize: number,
        chunkOverlap: number,
    ): string[] {
        const normalizedText: string = sectionText.trim();
        if (normalizedText.length === 0) {
            return [];
        }

        if (normalizedText.length <= chunkSize) {
            return [normalizedText]
        }

        const paragraphs: string[] = normalizedText
            .split(/\n\s*\n/g)
            .map((paragraph: string) => paragraph.trim())
            .filter((paragraph: string) => paragraph.length > 0);

        const chunks: string[] = []
        let currentChunk: string = ""

        const pushCurrentChunk = (): void => {
            const trimmedChunk: string = currentChunk.trim();
            if (trimmedChunk.length > 0) {
                chunks.push(trimmedChunk);
            }
        };

        for (const paragraph of paragraphs) {
            // 如果一个段落本身长度超过 chunkSize， 那么退化为字符窗口切分
            if (paragraph.length > chunkSize) {
                pushCurrentChunk();
                currentChunk = "";

                const oversizedChunks: string[] = this.splitOversizedText(paragraph, chunkSize, chunkOverlap);
                chunks.push(...oversizedChunks);
                continue;
            }

            const candidateChunk: string = currentChunk.length === 0
                ? paragraph
                : `${currentChunk}\n\n${paragraph}`

            if (candidateChunk.length <= chunkSize) {
                currentChunk = candidateChunk;
                continue;
            }

            // 当前 chunk 已经接近上限，先入栈，再用 overlap 的尾部作为下一个 chunk 的开头。
            const previousChunk: string = currentChunk;
            pushCurrentChunk();

            const overlapPrefix: string = this.extractOverlapPrefix(previousChunk, chunkOverlap);
            currentChunk = overlapPrefix.length > 0
                ?`${overlapPrefix}\n\n${paragraph}`
                : paragraph;
        }

        pushCurrentChunk();
        return chunks;
    }

    /**
     * 对超长文本做字符窗口切分。
     * 这是 chunking 的兜底逻辑。
     */
    private splitOversizedText(text: string, chunkSize: number, chunkOverlap: number): string[] {
        const chunks: string[] = [];
        const step: number = Math.max(1, chunkSize - chunkOverlap) ;

        for (let start = 0; start < text.length; start += step) {
            const end: number = Math.min(text.length, start + chunkSize);
            const slice: string = text.slice(start, end).trim();

            if (slice.length > 0 ) {
                chunks.push(slice);
            }

            if (end >= text.length) {
                break;
            }
        }

        return chunks;
    }

    /**
     * 提取 overlap 前缀。
     *
     * 注意：这里不是严格的“token overlap”，而是字符级 overlap，
     * 目的是让相邻 chunk 之间保留少量上下文。
     */
    private extractOverlapPrefix(previousChunk: string, chunkOverlap: number) : string {
        if (chunkOverlap <= 0) {
            return "";
        }

        return previousChunk.slice(-chunkOverlap).trim();
    }

    /**
     * 轻量级 tokenizer。
     *
     * 这里特别考虑了中英文混合笔记场景：
     * - 英文与数字：按单词切分
     * - 中文：同时拆成单字与双字 token，提升中文关键词命中率
     */
    private tokenize(text: string): string[] {
        const normalizedText: string = text.toLowerCase();
        const tokens: string[] = [];

        // 英文 / 数字 / 下划线 / 连字符 / 点号 等 token
        const latinTokens: RegExpMatchArray | null = normalizedText.match(/[a-z0-9_./-]+/g);
        if (latinTokens) {
            for (const token of latinTokens) {
                const cleanedToken: string = token.trim();
                if (cleanedToken.length > 0) {
                    tokens.push(cleanedToken);
                }
            }
        }

        // 中文序列 token
        const chineseSequences: RegExpMatchArray | null = normalizedText.match(/[\u4e00-\u9fff]+/g);
        if (chineseSequences) {
            for (const sequence of chineseSequences) {
                // 单字 token
                // for (let index = 0; index < sequence.length; index += 1) {
                for (const char of sequence) {
                    // TypeScript 报错的原因是：它不会把这种“循环边界保证索引合法”的事实精确推导到 sequence[index] 的类型里。
                    // tokens.push(sequence[index]);
                    tokens.push(char)
                }

                // 双字 token，用来提升中文词语级匹配能力
                for (let index = 0; index < sequence.length - 1; index += 1) {
                    tokens.push(sequence.slice(index, index + 2));
                }
            }
        }

        return tokens;
    }

    /**
     * 用于短语匹配的归一化。
     * 这里会去掉多余空白并转成小写。
     */
    private normalizeForPhraseMatch(text: string): string {
        return text.toLowerCase().replace(/\s+/g, " ").trim();
    }

    /**
     * 对向量做 L2 归一化。
     *
     * 归一化后的向量长度为 1，后续计算余弦相似度时可以直接使用点积。
     * ? 不需要减去均值吗？
     */
    private normalizeVector(vector: number[]): number[] {
        if (vector.length === 0 ){
            return [];
        }

        let sumOfSquares = 0;
        for (const value of vector) {
            sumOfSquares += value * value;
        }

        const norm: number = Math.sqrt(sumOfSquares);
        if (norm === 0) {
            return [];
        }

        return vector.map((value:number) => value / norm);
    }

    /**
     * 计算两个等长向量的点积。
     *
     * 注意：这里假设调用前已经保证维度兼容；
     * 如果维度不一致，则以较短长度为准，避免运行时崩溃。
     */
    private dot(left: number[], right: number[]): number {
        const length: number = Math.min(left.length, right.length);
        let score = 0;

        for (let index = 0; index < length; index+=1) {
            const leftValue: number | undefined = left[index];
            const rightValue: number | undefined = right[index];
            if (leftValue != undefined && rightValue != undefined) {
                score += leftValue * rightValue;
            }
        }
        return score;
    }

    /**
     * 统一处理目录路径，避免用户输入前后空格或多余斜杠导致判断出错。
     */
    private normalizeFolderPath(folderPath: string): string {
        const trimmedFolderPath: string = folderPath.trim();
        if (trimmedFolderPath.length === 0) {
            return "";
        }

        return normalizePath(trimmedFolderPath).replace(/\/$/, "");
    }

    /**
     * 生成人类可读的当前索引范围说明。
     */
    private describeCurrentScope(): string {
        const settings: VaultCoachSettings = this.getSettings();
        if (settings.knowledgeScopeMode === "wholeVault") {
            return "整个 Vault";
        }

        const normalizedFolder: string = this.normalizeFolderPath(settings.knowledgeFolder);
        return normalizedFolder.length > 0
            ? `目录：${normalizedFolder}`
            : "目录：未指定";
    }

    private hashContent(content: string): string {
        let hash = 2166136261;

        for (let index = 0; index < content.length; index += 1) {
            hash ^= content.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }

        return `${content.length}:${(hash >>> 0).toString(16)}`;
    }

    private isMarkdownPath(path: string): boolean {
        return path.toLowerCase().endsWith(".md");
    }
}





