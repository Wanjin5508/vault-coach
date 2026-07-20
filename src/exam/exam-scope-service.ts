import type {
    ExamContentProfile,
    ExamFileOption,
    ExamScopeAnalysisResult,
    ExamScopeAnalysisSummary,
    ExamScopeOption,
    ExamScopeSelection,
    ExamScopeSnapshot,
} from "../domain/exam/exam-types";
import type { DocumentFileMetadataReader } from "../domain/documents/document-file-metadata-reader";
import type { DocumentIndexReader } from "../domain/documents/document-index-reader";
import type { IndexedChunk, KnowledgeBaseFileRecord } from "../domain/documents/document-types";
import type { VaultCoachSettings } from "../app/config/settings-types";
import { headingPathMatches } from "./exam-utils";
import {
    cleanExamMarkdownText,
    findMatchingExamExcludeRule,
    getParentFolderPaths,
    isFileInFolder,
    isVaultCoachHiddenPath,
    normalizeVaultPath,
} from "./exam-scope-rules";

/**
 * Sort vault paths by JavaScript code units rather than the host locale.
 *
 * `localeCompare()` produces different Chinese ordering under different ICU
 * builds, which makes scope selection and generated exam input nondeterministic
 * across developer machines and CI runners.
 */
function compareStablePaths(leftPath: string, rightPath: string): number {
    if (leftPath === rightPath) {
        return 0;
    }

    return leftPath < rightPath ? -1 : 1;
}

/**
 * 规则过滤后的文件分组结果。
 */
export interface ExamResolvedScope {
    fileOptions: ExamFileOption[];
    ruleExcludedFiles: ExamFileOption[];
    manualExcludedFiles: ExamFileOption[];
    candidateFiles: ExamFileOption[];
}

/**
 * 考试范围服务。
 *
 * 负责把当前文档索引、用户的考试范围选择和设置规则合成为可出题的文件与 chunk。
 * 它只依赖读取端口，因此不再知道 VaultKnowledgeBase 的具体实现。
 */
export class ExamScopeService {
    private readonly documentIndex: DocumentIndexReader;
    private readonly fileMetadataReader: DocumentFileMetadataReader;
    private readonly getSettings: () => VaultCoachSettings;

    constructor(
        documentIndex: DocumentIndexReader,
        fileMetadataReader: DocumentFileMetadataReader,
        getSettings: () => VaultCoachSettings,
    ) {
        this.documentIndex = documentIndex;
        this.fileMetadataReader = fileMetadataReader;
        this.getSettings = getSettings;
    }

    /**
     * 构造考试模式可选择的目录范围。
     */
    getFolderScopeOptions(): ExamScopeOption[] {
        const folderStats: Map<string, { filePaths: Set<string>; chunkCount: number }> = new Map();

        for (const chunk of this.documentIndex.getAllChunks()) {
            const parentFolders: string[] = getParentFolderPaths(chunk.filePath);
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
            .sort(([leftPath], [rightPath]) => compareStablePaths(leftPath, rightPath))
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
    getFileOptions(folderPaths: string[]): ExamFileOption[] {
        const filePaths: string[] = this.resolveFilePathsForFolders(folderPaths);
        return filePaths.map((filePath: string) => this.buildFileOption(filePath));
    }

    /**
     * 计算考试范围快照，供 UI 估算题量和展示筛选结果。
     */
    getScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot {
        const resolvedScope: ExamResolvedScope = this.resolveScope(selection);
        const eligibleChunkCount: number = resolvedScope.candidateFiles.reduce((sum: number, option: ExamFileOption) => {
            return sum + option.chunkCount;
        }, 0);
        const estimatedMaxQuestions: number = this.estimateMaxExamQuestions(
            resolvedScope.candidateFiles.length,
            eligibleChunkCount,
        );

        return {
            totalFileCount: resolvedScope.fileOptions.length,
            eligibleFileCount: resolvedScope.candidateFiles.length,
            excludedFileCount: resolvedScope.fileOptions.length - resolvedScope.candidateFiles.length,
            eligibleChunkCount,
            estimatedMinQuestions: estimatedMaxQuestions > 0
                ? Math.max(1, Math.min(estimatedMaxQuestions, Math.floor(estimatedMaxQuestions / 2) || 1))
                : 0,
            estimatedMaxQuestions,
        };
    }

    /**
     * 返回通过目录、永久规则和手动排除过滤后的全部 chunk。
     */
    getChunksForScope(selectionOrFolderPaths: ExamScopeSelection | string[]): IndexedChunk[] {
        const selection: ExamScopeSelection = Array.isArray(selectionOrFolderPaths)
            ? {
                selectedFolderPaths: selectionOrFolderPaths,
                excludedFilePaths: [],
                forceIncludedFilePaths: [],
            }
            : selectionOrFolderPaths;
        const allowedFilePaths: Set<string> = new Set(
            this.resolveScope(selection).candidateFiles.map((fileOption: ExamFileOption) => fileOption.filePath),
        );

        return this.documentIndex.getAllChunks()
            .filter((chunk: IndexedChunk) => allowedFilePaths.has(chunk.filePath));
    }

    /**
     * 根据用户选择拆分规则排除、手动排除和候选文件。
     */
    resolveScope(selection: ExamScopeSelection): ExamResolvedScope {
        const fileOptions: ExamFileOption[] = this.getFileOptions(selection.selectedFolderPaths);
        const excludedPathSet: Set<string> = this.normalizePathSet(selection.excludedFilePaths);
        const ruleExcludedFiles: ExamFileOption[] = [];
        const manualExcludedFiles: ExamFileOption[] = [];
        const candidateFiles: ExamFileOption[] = [];

        for (const fileOption of fileOptions) {
            if (fileOption.permanentlyExcluded) {
                ruleExcludedFiles.push(fileOption);
                continue;
            }

            if (excludedPathSet.has(fileOption.filePath)) {
                manualExcludedFiles.push(fileOption);
                continue;
            }

            candidateFiles.push(fileOption);
        }

        return {
            fileOptions,
            ruleExcludedFiles,
            manualExcludedFiles,
            candidateFiles,
        };
    }

    /**
     * 获取最终可用于出题的 chunk。
     *
     * 当启用智能筛选时，partial 文件只保留画像中标记为可考试的标题路径。
     */
    getEligibleChunks(selection: ExamScopeSelection, profiles: ExamContentProfile[], semanticFilteringEnabled: boolean): IndexedChunk[] {
        const resolvedScope: ExamResolvedScope = this.resolveScope(selection);
        const forceIncludedPathSet: Set<string> = this.normalizePathSet(selection.forceIncludedFilePaths);
        const profileByPath: Map<string, ExamContentProfile> = new Map<string, ExamContentProfile>(
            profiles.map((profile: ExamContentProfile) => [profile.filePath, profile]),
        );
        const chunks: IndexedChunk[] = [];

        for (const fileOption of resolvedScope.candidateFiles) {
            const fileChunks: IndexedChunk[] = this.documentIndex.getChunksByFilePath(fileOption.filePath);
            if (fileChunks.length === 0) {
                continue;
            }

            if (forceIncludedPathSet.has(fileOption.filePath) || !semanticFilteringEnabled) {
                chunks.push(...fileChunks);
                continue;
            }

            const profile: ExamContentProfile | undefined = profileByPath.get(fileOption.filePath);
            if (!profile || profile.decision === "include") {
                chunks.push(...fileChunks);
                continue;
            }

            if (profile.decision === "exclude") {
                continue;
            }

            const eligibleHeadingPaths: string[][] = profile.eligibleHeadingPaths;
            if (eligibleHeadingPaths.length === 0) {
                continue;
            }

            chunks.push(...fileChunks.filter((chunk: IndexedChunk) => {
                return eligibleHeadingPaths.some((headingPath: string[]) => headingPathMatches(chunk.headingPath, headingPath));
            }));
        }

        return chunks;
    }

    /**
     * 构造 UI 展示和生成阶段复用的范围分析结果。
     */
    buildAnalysisResult(
        selection: ExamScopeSelection,
        resolvedScope: ExamResolvedScope,
        profiles: ExamContentProfile[],
        eligibleChunks: IndexedChunk[],
        promptVersion: string,
        cacheHits: number,
        cacheMisses: number,
    ): ExamScopeAnalysisResult {
        const profileByPath: Map<string, ExamContentProfile> = new Map<string, ExamContentProfile>(
            profiles.map((profile: ExamContentProfile) => [profile.filePath, profile]),
        );
        const forceIncludedPathSet: Set<string> = this.normalizePathSet(selection.forceIncludedFilePaths);
        const semanticExcludedFiles: number = resolvedScope.candidateFiles.filter((fileOption: ExamFileOption) => {
            return !forceIncludedPathSet.has(fileOption.filePath)
                && profileByPath.get(fileOption.filePath)?.decision === "exclude";
        }).length;
        const partialFiles: number = resolvedScope.candidateFiles.filter((fileOption: ExamFileOption) => {
            return !forceIncludedPathSet.has(fileOption.filePath)
                && profileByPath.get(fileOption.filePath)?.decision === "partial";
        }).length;
        const includedFiles: number = resolvedScope.candidateFiles.filter((fileOption: ExamFileOption) => {
            const profile: ExamContentProfile | undefined = profileByPath.get(fileOption.filePath);
            return forceIncludedPathSet.has(fileOption.filePath) || !profile || profile.decision === "include";
        }).length;
        const estimatedMaxQuestions: number = this.estimateMaxExamQuestions(
            this.countEligibleFilePaths(eligibleChunks),
            eligibleChunks.length,
        );
        const summary: ExamScopeAnalysisSummary = {
            totalFiles: resolvedScope.fileOptions.length,
            ruleExcludedFiles: resolvedScope.ruleExcludedFiles.length,
            manualExcludedFiles: resolvedScope.manualExcludedFiles.length,
            semanticExcludedFiles,
            partialFiles,
            includedFiles,
            eligibleChunkCount: eligibleChunks.length,
            estimatedMinQuestions: estimatedMaxQuestions > 0 ? Math.max(1, Math.floor(estimatedMaxQuestions / 2) || 1) : 0,
            estimatedMaxQuestions,
            cacheHits,
            cacheMisses,
        };

        return {
            selection,
            profiles,
            summary,
            eligibleChunkIds: eligibleChunks.map((chunk: IndexedChunk) => chunk.id),
            promptVersion,
        };
    }

    /** Resolve indexed file paths included by the requested folders. */
    private resolveFilePathsForFolders(folderPaths: string[]): string[] {
        const normalizedFolderPaths: string[] = folderPaths
            .map((folderPath: string) => normalizeVaultPath(folderPath))
            .filter((folderPath: string) => folderPath.length > 0);

        return this.documentIndex.getFileRecords()
            .map((record: KnowledgeBaseFileRecord) => normalizeVaultPath(record.filePath))
            .filter((filePath: string) => {
                if (isVaultCoachHiddenPath(filePath)) {
                    return false;
                }

                if (normalizedFolderPaths.length === 0) {
                    return true;
                }

                return normalizedFolderPaths.some((folderPath: string) => isFileInFolder(filePath, folderPath));
            })
            .sort(compareStablePaths);
    }

    /** Build a file option together with its permanent exclusion reason. */
    private buildFileOption(filePath: string): ExamFileOption {
        const normalizedPath: string = normalizeVaultPath(filePath);
        const permanentExcludeReason: string | null = this.getPermanentExcludeReason(normalizedPath);
        const pathParts: string[] = normalizedPath.split("/");
        const fileName: string = pathParts[pathParts.length - 1] ?? normalizedPath;
        const parentFolder: string = pathParts.length > 1
            ? pathParts.slice(0, pathParts.length - 1).join("/")
            : "";

        return {
            filePath: normalizedPath,
            fileName,
            parentFolder,
            chunkCount: this.documentIndex.getChunksByFilePath(normalizedPath).length,
            permanentlyExcluded: permanentExcludeReason !== null,
            permanentExcludeReason: permanentExcludeReason ?? undefined,
        };
    }

    /** Determine whether a file must always be excluded from exam generation. */
    private getPermanentExcludeReason(filePath: string): string | null {
        if (isVaultCoachHiddenPath(filePath)) {
            return "VaultCoach hidden directory";
        }

        const fileMetadata = this.fileMetadataReader.getFileMetadata(filePath);
        if (fileMetadata === null) {
            return "File no longer exists";
        }

        if (this.isMarkdownPath(filePath)) {
            const examFlag: unknown = fileMetadata.frontmatter?.["vault_coach_exam"];
            if (examFlag === false || examFlag === "false") {
                return "vault_coach_exam: false";
            }
        }

        const fileRecord: KnowledgeBaseFileRecord | null = this.documentIndex.getFileRecord(filePath);
        if (fileRecord?.documentType === "pdf" && (fileRecord.extractionQuality ?? 1) < 0.35) {
            return "Low PDF extraction quality";
        }

        const matchedUserRule: string | null = findMatchingExamExcludeRule(
            filePath,
            this.getSettings().examExcludePathPatterns,
        );
        if (matchedUserRule !== null) {
            return `Matched exclude rule: ${matchedUserRule}`;
        }

        const chunks: IndexedChunk[] = this.documentIndex.getChunksByFilePath(filePath);
        if (chunks.length === 0) {
            return "Empty or heading-only note";
        }

        const rawText: string = chunks.map((chunk: IndexedChunk) => chunk.text).join("\n\n");
        if (cleanExamMarkdownText(rawText).length < 80) {
            return "Too little exam-ready body text";
        }

        return null;
    }

    /** Convert a caller-provided list of file paths into canonical lookup keys. */
    private normalizePathSet(filePaths: readonly string[]): Set<string> {
        return new Set(filePaths.map((filePath: string) => normalizeVaultPath(filePath)));
    }

    /** Whether a path represents a Markdown document. */
    private isMarkdownPath(filePath: string): boolean {
        return filePath.toLowerCase().endsWith(".md");
    }

    /** 统计可出题 chunk 覆盖的文件数。 */
    private countEligibleFilePaths(chunks: IndexedChunk[]): number {
        return new Set(chunks.map((chunk: IndexedChunk) => chunk.filePath)).size;
    }

    /** 基于文件数和 chunk 数估算题量上限。 */
    private estimateMaxExamQuestions(eligibleFileCount: number, eligibleChunkCount: number): number {
        if (eligibleFileCount === 0 || eligibleChunkCount === 0) {
            return 0;
        }

        const chunkCapacity: number = Math.max(1, Math.ceil(eligibleChunkCount / 2));
        const fileCapacity: number = Math.max(1, eligibleFileCount * 3);
        return Math.min(10, chunkCapacity, fileCapacity);
    }
}
