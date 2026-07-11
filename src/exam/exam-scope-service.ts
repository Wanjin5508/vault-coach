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

export interface ExamResolvedScope {
    fileOptions: ExamFileOption[];
    ruleExcludedFiles: ExamFileOption[];
    manualExcludedFiles: ExamFileOption[];
    candidateFiles: ExamFileOption[];
}

export class ExamScopeService {
    private readonly knowledgeBase: VaultKnowledgeBase;

    constructor(knowledgeBase: VaultKnowledgeBase) {
        this.knowledgeBase = knowledgeBase;
    }

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

    private countEligibleFilePaths(chunks: IndexedChunk[]): number {
        return new Set(chunks.map((chunk: IndexedChunk) => chunk.filePath)).size;
    }

    private estimateMaxExamQuestions(eligibleFileCount: number, eligibleChunkCount: number): number {
        if (eligibleFileCount === 0 || eligibleChunkCount === 0) {
            return 0;
        }

        const chunkCapacity: number = Math.max(1, Math.ceil(eligibleChunkCount / 2));
        const fileCapacity: number = Math.max(1, eligibleFileCount * 3);
        return Math.min(10, chunkCapacity, fileCapacity);
    }
}
