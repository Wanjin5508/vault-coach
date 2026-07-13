import { VaultKnowledgeBase } from "../knowledge-base";
import type {
    ExamContentProfile,
    ExamFileOption,
    ExamScopeAnalysisResult,
    ExamScopeAnalysisSummary,
    ExamScopeSelection,
    IndexedChunk,
} from "../types";
import { headingPathMatches } from "./exam-utils";

/**
 * 考试范围解析模块。
 *
 * 负责把用户选择的目录/文件排除、规则排除和内容画像合并成最终可用于出题的 chunk 集合。
 */

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
 */
export class ExamScopeService {
    private readonly knowledgeBase: VaultKnowledgeBase;

    constructor(knowledgeBase: VaultKnowledgeBase) {
        this.knowledgeBase = knowledgeBase;
    }

    /**
     * 根据用户选择拆分规则排除、手动排除和候选文件。
     */
    resolveScope(selection: ExamScopeSelection): ExamResolvedScope {
        const fileOptions: ExamFileOption[] = this.knowledgeBase.getExamFileOptions(selection.selectedFolderPaths);
        const excludedPathSet: Set<string> = new Set(selection.excludedFilePaths);
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
        const forceIncludedPathSet: Set<string> = new Set(selection.forceIncludedFilePaths);
        const profileByPath: Map<string, ExamContentProfile> = new Map<string, ExamContentProfile>(
            profiles.map((profile: ExamContentProfile) => [profile.filePath, profile]),
        );
        const chunks: IndexedChunk[] = [];

        for (const fileOption of resolvedScope.candidateFiles) {
            const fileChunks: IndexedChunk[] = this.knowledgeBase.getExamFileChunks(fileOption.filePath);
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
        const forceIncludedPathSet: Set<string> = new Set(selection.forceIncludedFilePaths);
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

    /**
     * 统计可出题 chunk 覆盖的文件数。
     */
    private countEligibleFilePaths(chunks: IndexedChunk[]): number {
        return new Set(chunks.map((chunk: IndexedChunk) => chunk.filePath)).size;
    }

    /**
     * 基于文件数和 chunk 数估算题量上限。
     */
    private estimateMaxExamQuestions(eligibleFileCount: number, eligibleChunkCount: number): number {
        if (eligibleFileCount === 0 || eligibleChunkCount === 0) {
            return 0;
        }

        const chunkCapacity: number = Math.max(1, Math.ceil(eligibleChunkCount / 2));
        const fileCapacity: number = Math.max(1, eligibleFileCount * 3);
        return Math.min(10, chunkCapacity, fileCapacity);
    }
}
