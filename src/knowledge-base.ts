import { App, TFile, normalizePath } from "obsidian";
import { VAULT_COACH_HIDDEN_DIR_PATH } from "./constants";
import { createDocumentId, hashArrayBuffer, hashString, type DocumentParser, DocumentParserRegistry } from "./document-parser";
import { MarkdownDocumentParser } from "./markdown-document-parser";
import { PdfDocumentParser } from "./pdf-document-parser";
import type { DocumentIndexReader } from "./domain/documents/document-index-reader";
import type {
    ChunkContentKind,
    DocumentLocator,
    IndexedChunk,
    KnowledgeBaseFileRecord,
    KnowledgeBaseStats,
    KnowledgeBaseSyncResult,
    KeywordSearchHit,
    ParsedDocument,
    ParsedDocumentBlock,
} from "./domain/documents/document-types";
import type {
    ExamFileOption,
    ExamScopeOption,
    ExamScopeSelection,
    ExamScopeSnapshot,
} from "./domain/exam/exam-types";
import type { KnowledgeBaseSnapshot } from "./infrastructure/storage/storage-types";
import type { VaultCoachSettings } from "./app/config/settings-types";

const DOCUMENT_CHUNKER_VERSION = "document-chunker-v2";
const DOCUMENT_PARSER_LAYER_VERSION = "document-parser-v2";

/**
 * VaultKnowledgeBase 负责插件共享的知识库底座：
 * 1. 扫描 vault / 指定目录中的已启用知识文件
 * 2. 通过文档解析器把不同载体转换为统一 block
 * 3. 建立倒排索引用于关键词检索
 * 4. 维护 chunk 元数据，向量存储由独立 VectorStore 负责
 *
 * 设计原则：
 * - 它不直接关心 LLM 生成回答；
 * - 它只负责“把知识文件变成可检索的数据结构”。
 */
export class VaultKnowledgeBase implements DocumentIndexReader {
    private readonly app: App;
    // 使用函数注入设置读取器，确保每次索引或检索都能拿到最新设置。
    private readonly getSettings: () => VaultCoachSettings;
    private readonly parserRegistry: DocumentParserRegistry;

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

    private readonly fileChunkIds: Map<string, string[]> = new Map<string, string[]>();
    private readonly fileHashes: Map<string, string> = new Map<string, string>();
    private readonly fileRecords: Map<string, KnowledgeBaseFileRecord> = new Map<string, KnowledgeBaseFileRecord>();

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
        this.parserRegistry = new DocumentParserRegistry([
            new MarkdownDocumentParser(app),
            new PdfDocumentParser(app, getSettings),
        ]);
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
        };
    }

    /**
     * 获取全部 chunk。
     * 向量索引、考试模式和快照持久化都会通过这个方法读取当前文本索引。
     */
    getAllChunks(): IndexedChunk[] {
        return [...this.chunks];
    }

    /**
     * 按 ID 读取单个索引块。
     */
    getChunkById(chunkId: string): IndexedChunk | null {
        return this.chunkMap.get(chunkId) ?? null;
    }

    /**
     * 按 ID 批量读取索引块，并保留调用方传入的顺序。
     */
    getChunksByIds(chunkIds: readonly string[]): IndexedChunk[] {
        const chunks: IndexedChunk[] = [];
        for (const chunkId of chunkIds) {
            const chunk: IndexedChunk | undefined = this.chunkMap.get(chunkId);
            if (chunk) {
                chunks.push(chunk);
            }
        }
        return chunks;
    }

    /**
     * 读取某个 Vault 文件的全部已索引 chunk。
     */
    getChunksByFilePath(filePath: string): IndexedChunk[] {
        return this.getChunksForFilePath(normalizePath(filePath));
    }

    /**
     * 获取某个文件的索引元数据。
     */
    getFileRecord(filePath: string): KnowledgeBaseFileRecord | null {
        const record: KnowledgeBaseFileRecord | undefined = this.fileRecords.get(normalizePath(filePath));
        if (!record) {
            return null;
        }

        return {
            ...record,
            chunkIds: [...record.chunkIds],
        };
    }

    /**
     * 读取文档原始文本；非 Markdown 文档使用已解析 chunk 的拼接文本。
     */
    async readDocumentText(filePath: string): Promise<string | null> {
        const abstractFile = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
        if (!(abstractFile instanceof TFile)) {
            return null;
        }

        if (!this.isMarkdownPath(abstractFile.path)) {
            const chunks: IndexedChunk[] = this.getChunksByFilePath(abstractFile.path);
            return chunks.map((chunk: IndexedChunk) => chunk.text).join("\n\n");
        }

        return this.app.vault.cachedRead(abstractFile);
    }

    /**
     * 获取考试文件的内容哈希，用于画像缓存键。
     */
    getExamFileContentHash(filePath: string): string | null {
        return this.fileHashes.get(normalizePath(filePath)) ?? null;
    }

    /**
     * 获取某个考试文件对应的 chunk。
     */
    getExamFileChunks(filePath: string): IndexedChunk[] {
        return this.getChunksByFilePath(filePath);
    }

    /**
     * 按 chunkId 批量读取 chunk。
     */
    getExamChunksByIds(chunkIds: string[]): IndexedChunk[] {
        return this.getChunksByIds(chunkIds);
    }

    /**
     * 读取考试文件原文。
     *
     * Markdown 文件返回原始内容；非 Markdown 文档返回已解析 chunk 的拼接文本。
     */
    async readExamFileContent(filePath: string): Promise<string | null> {
        return this.readDocumentText(filePath);
    }

    /**
     * 构造考试模式可选择的目录范围。
     */
    getExamFolderScopeOptions(): ExamScopeOption[] {
        const folderStats: Map<string, { filePaths: Set<string>; chunkCount: number }> = new Map();

        for (const chunk of this.chunks) {
            const parentFolders: string[] = this.getParentFolderPaths(chunk.filePath);
            for (const folderPath of parentFolders) {
                const stats = folderStats.get(folderPath) ?? {
                    filePaths: new Set<string>(),
                    chunkCount: 0,
                };
                stats.filePaths.add(chunk.filePath);
                stats.chunkCount += 1;
                folderStats.set(folderPath, stats);
            }
        }

        return Array.from(folderStats.entries())
            .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
            .map(([folderPath, stats]) => ({
                id: folderPath,
                label: folderPath,
                folderPath,
                fileCount: stats.filePaths.size,
                chunkCount: stats.chunkCount,
            }));
    }

    /**
     * 根据目录范围构造考试文件选项。
     */
    getExamFileOptions(folderPaths: string[]): ExamFileOption[] {
        const filePaths: string[] = this.resolveExamFilePathsForFolders(folderPaths);
        return filePaths.map((filePath: string) => this.buildExamFileOption(filePath));
    }

    /**
     * 计算考试范围快照，供 UI 估算题量和展示筛选结果。
     */
    getExamScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot {
        const fileOptions: ExamFileOption[] = this.getExamFileOptions(selection.selectedFolderPaths);
        const excludedPathSet: Set<string> = new Set(selection.excludedFilePaths.map((filePath: string) => normalizePath(filePath)));
        const eligibleFiles: ExamFileOption[] = fileOptions.filter((option: ExamFileOption) => {
            return !option.permanentlyExcluded && !excludedPathSet.has(option.filePath);
        });
        const eligibleChunkCount: number = eligibleFiles.reduce((sum: number, option: ExamFileOption) => {
            return sum + option.chunkCount;
        }, 0);
        const estimatedMaxQuestions: number = this.estimateMaxExamQuestions(eligibleFiles.length, eligibleChunkCount);

        return {
            totalFileCount: fileOptions.length,
            eligibleFileCount: eligibleFiles.length,
            excludedFileCount: fileOptions.length - eligibleFiles.length,
            eligibleChunkCount,
            estimatedMinQuestions: estimatedMaxQuestions > 0 ? Math.max(1, Math.min(estimatedMaxQuestions, Math.floor(estimatedMaxQuestions / 2) || 1)) : 0,
            estimatedMaxQuestions,
        };
    }

    /**
     * 根据考试范围选择返回可用于出题的 chunk。
     */
    getChunksForExamScope(selectionOrFolderPaths: ExamScopeSelection | string[]): IndexedChunk[] {
        const selection: ExamScopeSelection = Array.isArray(selectionOrFolderPaths)
            ? {
                selectedFolderPaths: selectionOrFolderPaths,
                excludedFilePaths: [],
                forceIncludedFilePaths: [],
            }
            : selectionOrFolderPaths;

        const excludedPathSet: Set<string> = new Set(selection.excludedFilePaths.map((filePath: string) => normalizePath(filePath)));
        const allowedFilePaths: Set<string> = new Set(
            this.getExamFileOptions(selection.selectedFolderPaths)
                .filter((option: ExamFileOption) => !option.permanentlyExcluded && !excludedPathSet.has(option.filePath))
                .map((option: ExamFileOption) => option.filePath),
        );

        return this.chunks.filter((chunk: IndexedChunk) => allowedFilePaths.has(chunk.filePath));
    }

    /**
     * 获取文件级索引记录，用于持久化快照。
     */
    getFileRecords(): KnowledgeBaseFileRecord[] {
        return Array.from(this.fileRecords.values()).map((record: KnowledgeBaseFileRecord) => ({
            ...record,
            chunkIds: [...record.chunkIds],
        }));
    }

    /**
     * 清空索引数据。
     */
    clearIndexData(): void {
        this.clearIndex();
    }

    /**
     * 生成影响文本索引有效性的设置签名。
     */
    getSettingsSignature(): string {
        const settings: VaultCoachSettings = this.getSettings();
        return JSON.stringify({
            knowledgeScopeMode: settings.knowledgeScopeMode,
            knowledgeFolder: this.normalizeFolderPath(settings.knowledgeFolder),
            enableMarkdownIndexing: settings.enableMarkdownIndexing,
            enablePdfIndexing: settings.enablePdfIndexing,
            maxPdfFileSizeMb: settings.maxPdfFileSizeMb,
            maxPdfPageCount: settings.maxPdfPageCount,
            chunkSize: settings.chunkSize,
            chunkOverlap: settings.chunkOverlap,
            parserLayer: DOCUMENT_PARSER_LAYER_VERSION,
            chunkerVersion: DOCUMENT_CHUNKER_VERSION,
        });
    }

    /**
     * 从磁盘快照恢复文本索引、文件级元数据与向量索引
     */
    loadFromSnapshot(snapshot: Pick<KnowledgeBaseSnapshot, "stats" | "chunks" | "files">): void {
        this.clearIndex();

        for (const record of snapshot.files) {
            this.fileChunkIds.set(record.filePath, [...record.chunkIds]);
            this.fileHashes.set(record.filePath, record.contentHash);
            this.fileRecords.set(record.filePath, {
                ...record,
                documentId: record.documentId ?? createDocumentId(record.documentType ?? "markdown", record.filePath),
                documentType: record.documentType ?? "markdown",
                chunkIds: [...record.chunkIds],
            });
        }

        for (const chunk of snapshot.chunks) {
            this.addChunkToIndex(this.normalizePersistedChunk(chunk));
        }

        this.stats = {
            ...snapshot.stats,
            scopeDescription: this.describeCurrentScope(),
        };
        this.rebuildChunkArray();
    }

    /**
     * 重建整个知识库索引。
     *
     * - 这里只负责扫描、切块和倒排索引；
     * - 向量索引由上层额外建立，因为向量索引依赖外部 embedding 模型。
     */
    async rebuildIndex(signal?: AbortSignal): Promise<KnowledgeBaseStats> {
        const result: KnowledgeBaseSyncResult = await this.rebuildIndexDetailed(signal);
        return result.stats;
    }

    /**
     * 全量重建并返回详细变更结果。
     *
     * changedChunks 供向量层批量重建 embedding，affectedFiles 供 UI 和日志解释本次操作范围。
     */
    async rebuildIndexDetailed(signal?: AbortSignal): Promise<KnowledgeBaseSyncResult> {
        signal?.throwIfAborted();
        this.clearIndex();

        const targetFiles: TFile[] = this.resolveTargetKnowledgeFiles();
        const changedChunks: IndexedChunk[] = [];

        for (const file of targetFiles) {
            signal?.throwIfAborted();
            try {
                const fileChunks: IndexedChunk[] = await this.parseFileToChunks(file, signal);
                for (const chunk of fileChunks) {
                    signal?.throwIfAborted();
                    this.addChunkToIndex(chunk);
                    changedChunks.push(chunk);
                }
            } catch (error: unknown) {
                if (this.isAbortError(error)) {
                    throw error;
                }
                console.error("[VaultCoach] 文档解析失败，已跳过：", file.path, error);
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

    /**
     * 增量同步发生变化的知识文件。
     *
     * 删除或移出范围的文件会返回 removedChunkIds；内容变化的文件会重新解析并返回 changedChunks。
     */
    async syncChangedFiles(filePaths: string[], signal?: AbortSignal): Promise<KnowledgeBaseSyncResult> {
        signal?.throwIfAborted();
        const dedupedPaths: string[] = Array.from(
            new Set(
                filePaths
                    .map((path: string) => path.trim())
                    .filter((path: string) => path.length > 0 && this.isSupportedKnowledgePath(path)),
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

        const currentFiles: Map<string, TFile> = new Map<string, TFile>();
        const targetFiles: TFile[] = this.resolveTargetKnowledgeFiles();
        for (const file of targetFiles) {
            currentFiles.set(file.path, file);
        }

        const changedChunks: IndexedChunk[] = [];
        const removedChunkIds: string[] = [];

        for (const filePath of dedupedPaths) {
            signal?.throwIfAborted();
            const existingFile: TFile | undefined = currentFiles.get(filePath);

            if (!existingFile) {
                removedChunkIds.push(...this.removeFileFromIndex(filePath));
                continue;
            }

            const contentHash: string = await this.readFileContentHash(existingFile);
            const previousHash: string | undefined = this.fileHashes.get(filePath);

            if (previousHash === contentHash) {
                continue;
            }

            removedChunkIds.push(...this.removeFileFromIndex(filePath));

            try {
                const fileChunks: IndexedChunk[] = await this.parseFileToChunks(existingFile, signal);
                for (const chunk of fileChunks) {
                    signal?.throwIfAborted();
                    this.addChunkToIndex(chunk);
                    changedChunks.push(chunk);
                }
            } catch (error: unknown) {
                if (this.isAbortError(error)) {
                    throw error;
                }
                console.error("[VaultCoach] 增量解析失败，已跳过：", existingFile.path, error);
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
     * 这里不是简单的 includes 判断，而是做轻量级打分：
     *   - token 命中次数（tf）
     *   - token 逆文档频率（idf）
     *   - 完整短语命中加分
     *   - 标题命中加分
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

        const scoreMap: Map<string, number> = new Map<string, number>();
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
     * 根据考试目录选择解析出实际文件路径。
     */
    private resolveExamFilePathsForFolders(folderPaths: string[]): string[] {
        const normalizedFolderPaths: string[] = folderPaths
            .map((folderPath: string) => this.normalizeFolderPath(folderPath))
            .filter((folderPath: string) => folderPath.length > 0);

        return Array.from(this.fileChunkIds.keys())
            .filter((filePath: string) => {
                if (this.isVaultCoachHiddenPath(filePath)) {
                    return false;
                }

                if (normalizedFolderPaths.length === 0) {
                    return true;
                }

                return normalizedFolderPaths.some((folderPath: string) => this.isFileInFolder(filePath, folderPath));
            })
            .sort((leftPath: string, rightPath: string) => leftPath.localeCompare(rightPath));
    }

    /**
     * 构造考试文件选项，并附带永久排除原因。
     */
    private buildExamFileOption(filePath: string): ExamFileOption {
        const normalizedPath: string = normalizePath(filePath);
        const permanentExcludeReason: string | null = this.getPermanentExamExcludeReason(normalizedPath);
        const pathParts: string[] = normalizedPath.split("/");
        const fileName: string = pathParts[pathParts.length - 1] ?? normalizedPath;
        const parentFolder: string = pathParts.length > 1
            ? pathParts.slice(0, pathParts.length - 1).join("/")
            : "";

        return {
            filePath: normalizedPath,
            fileName,
            parentFolder,
            chunkCount: this.getChunkCountForFilePath(normalizedPath),
            permanentlyExcluded: permanentExcludeReason !== null,
            permanentExcludeReason: permanentExcludeReason ?? undefined,
        };
    }

    /**
     * 判断文件是否应永久排除在考试模式之外。
     */
    private getPermanentExamExcludeReason(filePath: string): string | null {
        if (this.isVaultCoachHiddenPath(filePath)) {
            return "VaultCoach hidden directory";
        }

        const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
        if (!(abstractFile instanceof TFile)) {
            return "File no longer exists";
        }

        if (this.isMarkdownPath(abstractFile.path)) {
            const frontmatter = this.app.metadataCache.getFileCache(abstractFile)?.frontmatter;
            const examFlag: unknown = frontmatter?.["vault_coach_exam"];
            if (examFlag === false || examFlag === "false") {
                return "vault_coach_exam: false";
            }
        }

        const fileRecord: KnowledgeBaseFileRecord | undefined = this.fileRecords.get(filePath);
        if (fileRecord?.documentType === "pdf" && (fileRecord.extractionQuality ?? 1) < 0.35) {
            return "Low PDF extraction quality";
        }

        const matchedUserRule: string | null = this.findMatchingExamExcludeRule(filePath);
        if (matchedUserRule !== null) {
            return `Matched exclude rule: ${matchedUserRule}`;
        }

        const chunks: IndexedChunk[] = this.getChunksForFilePath(filePath);
        if (chunks.length === 0) {
            return "Empty or heading-only note";
        }

        const rawText: string = chunks.map((chunk: IndexedChunk) => chunk.text).join("\n\n");
        const cleanedText: string = this.cleanExamMarkdownText(rawText);
        if (cleanedText.length < 80) {
            return "Too little exam-ready body text";
        }

        return null;
    }

    /**
     * 根据用户配置的考试排除规则寻找命中的模式。
     */
    private findMatchingExamExcludeRule(filePath: string): string | null {
        const normalizedPath: string = normalizePath(filePath);
        const patterns: string[] = this.getSettings().examExcludePathPatterns
            .split(/\r?\n/g)
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0 && !line.startsWith("#"));

        for (const pattern of patterns) {
            const normalizedPattern: string = normalizePath(pattern.replace(/^\/+/, ""));
            if (this.matchesExamExcludePattern(normalizedPath, normalizedPattern)) {
                return pattern;
            }
        }

        return null;
    }

    /**
     * 判断文件路径是否匹配简单 glob 规则。
     */
    private matchesExamExcludePattern(filePath: string, pattern: string): boolean {
        if (pattern.length === 0) {
            return false;
        }

        if (!pattern.includes("*") && !pattern.includes("?")) {
            return filePath === pattern || filePath.startsWith(`${pattern}/`);
        }

        const doubleStarPlaceholder = "__VAULT_COACH_DOUBLE_STAR__";
        const escapedPattern: string = pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*/g, doubleStarPlaceholder)
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]")
            .replace(new RegExp(doubleStarPlaceholder, "g"), ".*");
        return new RegExp(`^${escapedPattern}$`).test(filePath);
    }

    /**
     * 使用确定性规则识别低质量考试内容。
     */
    private detectLowQualityExamContentReason(rawText: string, cleanedText: string): string | null {
        const contentLines: string[] = cleanedText
            .split(/\r?\n/g)
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0);
        const rawLines: string[] = rawText
            .split(/\r?\n/g)
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0);

        if (contentLines.length === 0) {
            return "Empty or heading-only note";
        }

        const checkboxLineCount: number = rawLines.filter((line: string) => /^[-*+]\s+\[[ xX]\]/.test(line)).length;
        const linkOnlyLineCount: number = rawLines.filter((line: string) => {
            const withoutLinks: string = line
                .replace(/\[\[[^\]]+\]\]/g, "")
                .replace(/\[[^\]]+\]\([^)]+\)/g, "")
                .replace(/^[-*+]\s+/, "")
                .trim();
            return withoutLinks.length <= 8 && (/\[\[[^\]]+\]\]/.test(line) || /\[[^\]]+\]\([^)]+\)/.test(line));
        }).length;
        const substantialParagraphCount: number = contentLines.filter((line: string) => {
            return line.length >= 24
                && !/^[-*+]\s+\[[ xX]\]/.test(line)
                && !/^[-*+]\s+\S+$/.test(line)
                && !/^#{1,6}\s+/.test(line);
        }).length;

        if (checkboxLineCount >= Math.max(3, Math.ceil(contentLines.length * 0.6)) && substantialParagraphCount <= 1) {
            return "Task-list dominant content";
        }

        if (linkOnlyLineCount >= Math.max(3, Math.ceil(contentLines.length * 0.6)) && substantialParagraphCount <= 1) {
            return "Link-index dominant content";
        }

        const commandOrLogLineCount: number = rawLines.filter((line: string) => {
            return /^(\$|>|npm |pnpm |yarn |cargo |go |python |Traceback|Error:|at\s+\S+\()/.test(line);
        }).length;
        if (commandOrLogLineCount >= Math.max(5, Math.ceil(rawLines.length * 0.6)) && substantialParagraphCount <= 1) {
            return "Raw command or log output";
        }

        return null;
    }

    /**
     * 清理 Markdown 标记，得到适合考试质量判断的正文文本。
     */
    private cleanExamMarkdownText(markdown: string): string {
        return markdown
            .replace(/^---[\s\S]*?---\s*/m, "")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/~~~[\s\S]*?~~~/g, "")
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/^#{1,6}\s+/gm, "")
            .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
            .replace(/[`*_~>#-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * 按文件路径读取 chunk。
     */
    private getChunksForFilePath(filePath: string): IndexedChunk[] {
        const chunkIds: string[] = this.fileChunkIds.get(filePath) ?? [];
        return chunkIds
            .map((chunkId: string) => this.chunkMap.get(chunkId))
            .filter((chunk: IndexedChunk | undefined): chunk is IndexedChunk => chunk !== undefined);
    }

    /**
     * 获取某个文件对应的 chunk 数量。
     */
    private getChunkCountForFilePath(filePath: string): number {
        return this.fileChunkIds.get(filePath)?.length ?? 0;
    }

    /**
     * 判断文件是否位于指定文件夹内。
     */
    private isFileInFolder(filePath: string, folderPath: string): boolean {
        const normalizedFolderPath: string = this.normalizeFolderPath(folderPath);
        if (normalizedFolderPath.length === 0) {
            return true;
        }

        return filePath.startsWith(`${normalizedFolderPath}/`);
    }

    /**
     * 根据有效文件数和 chunk 数估算可出题数量上限。
     */
    private estimateMaxExamQuestions(eligibleFileCount: number, eligibleChunkCount: number): number {
        if (eligibleFileCount === 0 || eligibleChunkCount === 0) {
            return 0;
        }

        const chunkCapacity: number = Math.max(1, Math.ceil(eligibleChunkCount / 2));
        const fileCapacity: number = Math.max(1, eligibleFileCount * 3);
        return Math.min(10, chunkCapacity, fileCapacity);
    }

    /**
     * 清空现有索引数据。
     */
    private clearIndex(): void {
        this.chunks = [];
        this.chunkMap.clear();
        this.invertedIndex.clear();
        this.fileChunkIds.clear();
        this.fileHashes.clear();
        this.fileRecords.clear();
        this.stats = {
            fileCount: 0,
            chunkCount: 0,
            lastIndexedAt: null,
            scopeDescription: this.describeCurrentScope(),
        };

    }

    /**
     * 更新索引统计信息。
     */
    private updateStats(fileCount: number): void {
        this.rebuildChunkArray();
        this.stats = {
            fileCount,
            chunkCount: this.chunks.length,
            lastIndexedAt: Date.now(),
            scopeDescription: this.describeCurrentScope(),
        };
    }

    /**
     * 从索引中移除指定文件及其所有 chunk。
     */
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
        }

        this.fileChunkIds.delete(filePath);
        this.fileHashes.delete(filePath);
        this.fileRecords.delete(filePath);
        this.rebuildChunkArray();
        return chunkIds;
    }

    /**
     * 从 chunkMap 重建有序 chunk 数组。
     */
    private rebuildChunkArray(): void {
        this.chunks = Array.from(this.chunkMap.values()).sort((left: IndexedChunk, right: IndexedChunk) => {
            const fileOrder: number = left.filePath.localeCompare(right.filePath);
            return fileOrder !== 0 ? fileOrder : left.id.localeCompare(right.id);
        });
    }

    /**
     * 根据设置解析当前应该纳入索引的知识库文件。
     */
    private resolveTargetKnowledgeFiles(): TFile[] {
        const settings: VaultCoachSettings = this.getSettings();
        const allKnowledgeFiles: TFile[] = this.app.vault.getFiles()
            .filter((file: TFile) => !this.isVaultCoachHiddenPath(file.path))
            .filter((file: TFile) => this.isSupportedKnowledgeFile(file));

        if (settings.knowledgeScopeMode === "wholeVault") {
            return allKnowledgeFiles.sort((left: TFile, right: TFile) => left.path.localeCompare(right.path));
        }

        const normalizedFolder: string = this.normalizeFolderPath(settings.knowledgeFolder);
        if (!normalizedFolder) {
            return [];
        }

        const folderPrefix: string = normalizedFolder.endsWith("/")
            ? normalizedFolder
            : `${normalizedFolder}/`

        return allKnowledgeFiles
            .filter((file: TFile) => file.path.startsWith(folderPrefix))
            .sort((left: TFile, right: TFile) => left.path.localeCompare(right.path));
    }

    /**
     * 获取文件所属的所有父级目录路径。
     */
    private getParentFolderPaths(filePath: string): string[] {
        const normalizedPath: string = normalizePath(filePath);
        const pathParts: string[] = normalizedPath.split("/");
        pathParts.pop();

        const folderPaths: string[] = [];
        for (let length = 1; length <= pathParts.length; length += 1) {
            const folderPath: string = pathParts.slice(0, length).join("/");
            if (folderPath.length > 0 && !this.isVaultCoachHiddenPath(folderPath)) {
                folderPaths.push(folderPath);
            }
        }

        return folderPaths;
    }

    /**
     * 使用匹配的解析器读取文件并转换为 chunk。
     */
    private async parseFileToChunks(file: TFile, signal?: AbortSignal): Promise<IndexedChunk[]> {
        signal?.throwIfAborted();
        const parser: DocumentParser | null = this.parserRegistry.resolve(file);
        if (!parser) {
            return [];
        }

        const parsedDocument: ParsedDocument = await parser.parse(file, { signal });
        signal?.throwIfAborted();
        const fileChunks: IndexedChunk[] = this.chunkParsedDocument(parsedDocument);
        const chunkIds: string[] = fileChunks.map((chunk: IndexedChunk) => chunk.id);

        this.fileChunkIds.set(file.path, chunkIds);
        this.fileHashes.set(file.path, parsedDocument.metadata.contentHash ?? "");
        this.fileRecords.set(file.path, {
            documentId: parsedDocument.documentId,
            documentType: parsedDocument.documentType,
            filePath: file.path,
            contentHash: parsedDocument.metadata.contentHash ?? "",
            fileSize: parsedDocument.metadata.fileSize ?? file.stat.size,
            modifiedTime: parsedDocument.metadata.modifiedTime ?? file.stat.mtime,
            parserVersion: parsedDocument.extraction.parserVersion,
            chunkerVersion: DOCUMENT_CHUNKER_VERSION,
            extractionQuality: parsedDocument.extraction.qualityScore,
            chunkIds,
            indexedAt: Date.now(),
        });

        return fileChunks;
    }

    /**
     * 将统一 ParsedDocument 切分为 IndexedChunk。
     *
     * 该方法按标题路径和 locator 兼容性聚合 block，再按 chunkSize/chunkOverlap 做文本切分。
     */
    private chunkParsedDocument(parsedDocument: ParsedDocument): IndexedChunk[] {
        const chunks: IndexedChunk[] = [];
        const settings: VaultCoachSettings = this.getSettings();
        const chunkSize: number = settings.chunkSize;
        const chunkOverlap: number = settings.chunkOverlap;
        const filePath: string = parsedDocument.filePath ?? "";
        const fileName: string = filePath.split("/").pop() ?? parsedDocument.title;

        if (parsedDocument.blocks.length === 0) {
            return chunks;
        }

        let chunkSerial: number = 0;
        let pendingBlocks: ParsedDocumentBlock[] = [];

        const flushPendingBlocks = (): void => {
            if (pendingBlocks.length === 0) {
                return;
            }

            const firstBlock: ParsedDocumentBlock | undefined = pendingBlocks[0];
            const headingPath: string[] = firstBlock?.headingPath ? [...firstBlock.headingPath] : [];
            const primaryHeading: string | undefined = headingPath[headingPath.length - 1];
            const locator: DocumentLocator = this.mergeLocators(pendingBlocks);
            const contentKind: ChunkContentKind = firstBlock?.contentKind ?? "native-text";
            const extractionQuality: number | undefined = this.averageExtractionQuality(pendingBlocks);
            const sectionText: string = pendingBlocks.map((block: ParsedDocumentBlock) => block.text).join("\n\n").trim();
            const chunkTexts: string[] = this.splitSectionTextIntoChunkTexts(sectionText, chunkSize, chunkOverlap);

            for (const chunkText of chunkTexts) {
                const searchableTextParts: string[] = [
                    parsedDocument.title,
                    ...headingPath,
                    this.buildLocatorSearchText(locator),
                    chunkText,
                ];

                const searchableText: string = searchableTextParts.join("\n").trim();
                const chunkId: string = `${parsedDocument.documentType}:${filePath}::${primaryHeading ?? "__root__"}::${chunkSerial}`;

                chunks.push({
                    id: chunkId,
                    documentId: parsedDocument.documentId,
                    documentType: parsedDocument.documentType,
                    filePath,
                    fileName,
                    headingPath: [...headingPath],
                    primaryHeading,
                    text: chunkText,
                    searchableText,
                    locator,
                    contentKind,
                    extractionQuality,
                });

                chunkSerial += 1;
            }

            pendingBlocks = [];
        };

        for (const block of parsedDocument.blocks) {
            if (block.kind === "heading") {
                flushPendingBlocks();
                continue;
            }

            if (pendingBlocks.length === 0) {
                pendingBlocks.push(block);
                continue;
            }

            const candidateBlocks: ParsedDocumentBlock[] = [...pendingBlocks, block];
            const candidateText: string = candidateBlocks.map((item: ParsedDocumentBlock) => item.text).join("\n\n");
            if (
                candidateText.length <= chunkSize
                && this.haveCompatibleHeadingPath(pendingBlocks[0], block)
                && this.canMergeLocatorRange(candidateBlocks)
            ) {
                pendingBlocks.push(block);
                continue;
            }

            flushPendingBlocks();
            pendingBlocks.push(block);
        }

        flushPendingBlocks();
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
     * 合并一组 block 的来源定位。
     *
     * PDF block 会合并为页码范围；Markdown/Zotero 直接保留首个定位。
     */
    private mergeLocators(blocks: ParsedDocumentBlock[]): DocumentLocator {
        const firstLocator: DocumentLocator | undefined = blocks[0]?.locator;
        if (!firstLocator) {
            return {
                type: "markdown",
                filePath: "",
            };
        }

        if (firstLocator.type !== "pdf") {
            return firstLocator;
        }

        let pageStart: number = firstLocator.pageStart;
        let pageEnd: number = firstLocator.pageEnd ?? firstLocator.pageStart;
        for (const block of blocks) {
            if (block.locator.type !== "pdf") {
                continue;
            }

            pageStart = Math.min(pageStart, block.locator.pageStart);
            pageEnd = Math.max(pageEnd, block.locator.pageEnd ?? block.locator.pageStart);
        }

        return {
            type: "pdf",
            filePath: firstLocator.filePath,
            pageStart,
            pageEnd,
        };
    }

    /**
     * 构造 locator 对应的可检索文本。
     */
    private buildLocatorSearchText(locator: DocumentLocator): string {
        if (locator.type === "pdf") {
            const pageEnd: number = locator.pageEnd ?? locator.pageStart;
            return pageEnd === locator.pageStart
                ? `第 ${locator.pageStart} 页`
                : `第 ${locator.pageStart}-${pageEnd} 页`;
        }

        if (locator.type === "markdown") {
            return locator.heading ?? "";
        }

        return locator.citationKey ?? locator.itemKey;
    }

    /**
     * 计算一组 block 的平均提取质量。
     */
    private averageExtractionQuality(blocks: ParsedDocumentBlock[]): number | undefined {
        const values: number[] = blocks
            .map((block: ParsedDocumentBlock) => block.extractionQuality)
            .filter((value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value));

        if (values.length === 0) {
            return undefined;
        }

        return values.reduce((sum: number, value: number) => sum + value, 0) / values.length;
    }

    /**
     * 判断两个 block 是否位于同一标题路径。
     */
    private haveCompatibleHeadingPath(left: ParsedDocumentBlock | undefined, right: ParsedDocumentBlock): boolean {
        const leftHeadingPath: string[] = left?.headingPath ?? [];
        const rightHeadingPath: string[] = right.headingPath ?? [];
        return leftHeadingPath.join("\u0000") === rightHeadingPath.join("\u0000");
    }

    /**
     * 判断一组 block 的 locator 是否可合并到同一个 chunk。
     */
    private canMergeLocatorRange(blocks: ParsedDocumentBlock[]): boolean {
        const firstLocator: DocumentLocator | undefined = blocks[0]?.locator;
        if (!firstLocator || firstLocator.type !== "pdf") {
            return true;
        }

        let pageStart: number = firstLocator.pageStart;
        let pageEnd: number = firstLocator.pageEnd ?? firstLocator.pageStart;
        for (const block of blocks) {
            if (block.locator.type !== "pdf") {
                return false;
            }

            pageStart = Math.min(pageStart, block.locator.pageStart);
            pageEnd = Math.max(pageEnd, block.locator.pageEnd ?? block.locator.pageStart);
        }

        return pageEnd - pageStart <= 1;
    }

    /**
     * 归一化旧快照中的 chunk，补齐新版本需要的字段。
     */
    private normalizePersistedChunk(chunk: IndexedChunk): IndexedChunk {
        const documentType = chunk.documentType ?? "markdown";
        const documentId: string = chunk.documentId ?? createDocumentId(documentType, chunk.filePath);
        const primaryHeading: string | undefined = chunk.primaryHeading ?? chunk.headingPath[chunk.headingPath.length - 1];
        const locator: DocumentLocator = chunk.locator ?? {
            type: "markdown",
            filePath: chunk.filePath,
            heading: primaryHeading,
        };

        return {
            ...chunk,
            documentId,
            documentType,
            primaryHeading,
            locator,
            contentKind: chunk.contentKind ?? "native-text",
        };
    }

    /**
     * 读取文件内容哈希。
     */
    private async readFileContentHash(file: TFile): Promise<string> {
        if (this.isPdfPath(file.path)) {
            return hashArrayBuffer(await this.app.vault.readBinary(file));
        }

        return hashString(await this.app.vault.cachedRead(file));
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

    /**
     * 判断路径是否为 Markdown 文件。
     */
    private isMarkdownPath(path: string): boolean {
        return path.toLowerCase().endsWith(".md");
    }

    /**
     * 判断路径是否为 PDF 文件。
     */
    private isPdfPath(path: string): boolean {
        return path.toLowerCase().endsWith(".pdf");
    }

    /**
     * 判断路径是否属于当前设置启用的知识文件类型。
     */
    private isSupportedKnowledgePath(path: string): boolean {
        const settings: VaultCoachSettings = this.getSettings();
        return (settings.enableMarkdownIndexing && this.isMarkdownPath(path))
            || (settings.enablePdfIndexing && this.isPdfPath(path));
    }

    /**
     * 判断文件是否能被当前解析器链处理。
     */
    private isSupportedKnowledgeFile(file: TFile): boolean {
        return this.isSupportedKnowledgePath(file.path) && this.parserRegistry.resolve(file) !== null;
    }

    /**
     * 判断路径是否位于 VaultCoach 隐藏目录中。
     */
    private isVaultCoachHiddenPath(path: string): boolean {
        const normalizedPath: string = normalizePath(path);
        return normalizedPath === VAULT_COACH_HIDDEN_DIR_PATH
            || normalizedPath.startsWith(`${VAULT_COACH_HIDDEN_DIR_PATH}/`);
    }

    /**
     * 识别 AbortError，避免把用户主动取消记录为失败。
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
}
