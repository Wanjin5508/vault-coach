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
interface MarkdownSection {
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
        return { ...this.stats }; // ? 什么用法？
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

            for (const chunk of fileChunks) {
                this.addChunkToIndex(chunk);
            }

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

    /**
     * 清空现有索引数据
     * 
     */
    // TODO 现在的索引都是保存在内存中，需要进行压力测试，看 vault 容量和内存用量的关联 》》 需要保存到硬盘
    private clearIndex(): void {
        this.chunks = [];
        this.chunkMap.clear();
        this.invertedIndex.clear();
        this.stats = {
            fileCount: 0,
            chunkCount: 0,
            lastIndexedAt: null,
            scopeDescription: this.describeCurrentScope(),
        };

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
        this.chunks.push(chunk);
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

                const hashes = headingMatch[1];
                const rawHeadingText = headingMatch[2];

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
                currentHeadingPath = currentHeadingPath.slice(0, Math.max(headingLevel - 1));
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





}





