import { App } from "obsidian";
import { LocalModelClient } from "../model-client";
import type {
    ExamMode,
    ExamContentProfile,
    ExamFileOption,
    ExamGenerationDiagnostics,
    ExamGenerationOptions,
    ExamQuestion,
    ExamScopeAnalysisResult,
    ExamScopeOption,
    ExamScopeSnapshot,
    ExamScopeSelection,
    ExamSession,
} from "../domain/exam/exam-types";
import { getExamModeOrDefault } from "../domain/exam/exam-question-policy";
import type { IndexedChunk } from "../domain/documents/document-types";
import type { DocumentFileMetadataReader } from "../domain/documents/document-file-metadata-reader";
import type { DocumentIndexReader } from "../domain/documents/document-index-reader";
import type { VaultCoachSettings } from "../app/config/settings-types";
import { ExamBlueprintService } from "./exam-blueprint-service";
import { ExamContentProfiler, EXAM_CONTENT_PROFILE_PROMPT_VERSION } from "./exam-content-profiler";
import { ExamQuestionGenerator, type ExamConceptIdsByChunk, ExamQuestionGenerationResult } from "./exam-question-generator";
import { ExamQuestionValidator } from "./exam-question-validator";
import { ExamProfileStore } from "./exam-profile-store";
import { ExamResolvedScope, ExamScopeService } from "./exam-scope-service";
import { throwIfAborted } from "./exam-utils";
import { createAdaptivePlanAuditSnapshot, type AdaptiveExamGenerationContext } from "../domain/adaptive-exam/adaptive-exam-types";
import { validateAdaptiveExamPlan } from "../domain/adaptive-exam/adaptive-exam-integrity";

/**
 * 考试模式编排引擎。
 *
 * 负责串联范围分析、内容画像、蓝图规划、题目生成和诊断信息收集。
 * 具体模型调用、题目校验和缓存读写分别下放到对应服务，避免主插件入口承载考试业务细节。
 */
export class ExamEngine {
    private readonly documentIndex: DocumentIndexReader;
    private readonly getSettings: () => VaultCoachSettings;
    private readonly client: LocalModelClient;
    private readonly profileStore: ExamProfileStore;
    private readonly scopeService: ExamScopeService;
    private readonly profiler: ExamContentProfiler;
    private readonly blueprintService: ExamBlueprintService;
    private readonly questionGenerator: ExamQuestionGenerator;

    constructor(
        app: App,
        documentIndex: DocumentIndexReader,
        fileMetadataReader: DocumentFileMetadataReader,
        getSettings: () => VaultCoachSettings,
        getCloudApiKey: () => string | null,
        private readonly getConceptIdsByChunk: () => ExamConceptIdsByChunk = () => new Map(),
    ) {
        this.documentIndex = documentIndex;
        this.getSettings = getSettings;
        this.client = new LocalModelClient(getSettings, getCloudApiKey);
        this.profileStore = new ExamProfileStore(app);
        this.scopeService = new ExamScopeService(documentIndex, fileMetadataReader, getSettings);
        this.profiler = new ExamContentProfiler(documentIndex, this.client, this.profileStore, getSettings);
        this.blueprintService = new ExamBlueprintService(this.client);
        this.questionGenerator = new ExamQuestionGenerator(
            this.client,
            new ExamQuestionValidator(),
            getSettings,
        );
    }

    /** 获取可选考试目录。 */
    getScopeOptions(): ExamScopeOption[] {
        return this.scopeService.getFolderScopeOptions();
    }

    /** 获取指定目录中的考试文件选项。 */
    getFileOptions(folderPaths: string[]): ExamFileOption[] {
        return this.scopeService.getFileOptions(folderPaths);
    }

    /** 获取考试范围的容量快照。 */
    getScopeSnapshot(selection: ExamScopeSelection): ExamScopeSnapshot {
        return this.scopeService.getScopeSnapshot(selection);
    }

    /** Whether the selected scope contains any rule-eligible document chunks. */
    hasEligibleChunks(selection: ExamScopeSelection): boolean {
        return this.scopeService.getChunksForScope(selection).length > 0;
    }

    /**
     * 分析当前考试范围。
     *
     * 该方法先应用目录/文件规则，再按配置决定是否运行语义内容画像，最终返回可出题 chunk 和摘要统计。
     */
    async analyzeScope(
        selection: ExamScopeSelection,
        options: ExamGenerationOptions = {},
    ): Promise<ExamScopeAnalysisResult> {
        const progress = options.onProgress;
        const scopeStart = Date.now();
        progress?.({
            phase: "resolving-scope",
            label: "正在收集考试文件",
        });
        throwIfAborted(options.abortSignal);

        const resolvedScope: ExamResolvedScope = this.scopeService.resolveScope(selection);
        progress?.({
            phase: "rule-filtering",
            label: "正在应用目录、文件和规则过滤",
        });
        throwIfAborted(options.abortSignal);

        const semanticFilteringEnabled: boolean = this.shouldUseSemanticFiltering(options);
        let profiles: ExamContentProfile[] = [];
        let cacheHits = 0;
        let cacheMisses = 0;

        if (semanticFilteringEnabled) {
            progress?.({
                phase: "semantic-filtering",
                label: "正在分析内容",
                current: 0,
                total: resolvedScope.candidateFiles.length,
            });
            const profileResult = await this.profiler.profileFiles(
                resolvedScope.candidateFiles,
                {
                    forceRefresh: options.forceProfileRefresh,
                    abortSignal: options.abortSignal,
                    onProgress: (current: number, total: number) => {
                        progress?.({
                            phase: "semantic-filtering",
                            label: `正在分析内容 ${current} / ${total}`,
                            current,
                            total,
                        });
                    },
                },
            );
            profiles = profileResult.profiles;
            cacheHits = profileResult.cacheHits;
            cacheMisses = profileResult.cacheMisses;
        } else {
            profiles = this.buildManualOnlyProfiles(resolvedScope);
        }

        const eligibleChunks: IndexedChunk[] = this.scopeService.getEligibleChunks(
            selection,
            profiles,
            semanticFilteringEnabled,
        );
        const result: ExamScopeAnalysisResult = this.scopeService.buildAnalysisResult(
            selection,
            resolvedScope,
            profiles,
            eligibleChunks,
            EXAM_CONTENT_PROFILE_PROMPT_VERSION,
            cacheHits,
            cacheMisses,
        );
        console.debug("[VaultCoach] Exam scope analysis complete", {
            totalFiles: result.summary.totalFiles,
            ruleExcludedFiles: result.summary.ruleExcludedFiles,
            manualExcludedFiles: result.summary.manualExcludedFiles,
            semanticExcludedFiles: result.summary.semanticExcludedFiles,
            partialFiles: result.summary.partialFiles,
            eligibleChunkCount: result.summary.eligibleChunkCount,
            cacheHits,
            cacheMisses,
            durationMs: Date.now() - scopeStart,
        });

        return result;
    }

    /**
     * 根据已选范围创建一次考试会话。
     *
     * 如果调用方已经传入分析结果，会复用该结果，避免重复运行智能筛选。
     */
    async createExamSession(
        scopeLabel: string,
        selection: ExamScopeSelection,
        questionCount: number,
        scopeSnapshot: ExamScopeSnapshot,
        options: ExamGenerationOptions = {},
    ): Promise<ExamSession> {
        const examMode: ExamMode = getExamModeOrDefault(options.examMode);
        const diagnosticsStart = Date.now();
        const durations = {
            scopeMs: 0,
            profilingMs: 0,
            planningMs: 0,
            generationMs: 0,
            validationMs: 0,
        };

        const progress = options.onProgress;
        const analysisStart = Date.now();
        const analysis: ExamScopeAnalysisResult = options.analysis ?? await this.analyzeScope(selection, options);
        durations.scopeMs = Date.now() - analysisStart;
        durations.profilingMs = durations.scopeMs;
        throwIfAborted(options.abortSignal);

        let eligibleChunks: IndexedChunk[] = this.documentIndex.getChunksByIds(analysis.eligibleChunkIds);
        if (eligibleChunks.length === 0) {
            throw new Error("当前考试范围内没有通过规则和智能筛选的可用片段。");
        }

        const adaptivePlan = options.adaptivePlan;
        if (adaptivePlan) {
            this.assertAdaptivePlanCanGenerate(adaptivePlan, examMode, analysis.eligibleChunkIds);
            const plannedChunkIds = new Set(adaptivePlan.targets.flatMap((target) => target.sourceChunkIds));
            eligibleChunks = eligibleChunks.filter((chunk) => plannedChunkIds.has(chunk.id));
            if (eligibleChunks.length === 0) {
                throw new Error("自适应考试计划没有保留当前范围内可出题的证据片段，请返回并重新分析。");
            }
        }

        const requestedQuestionCount: number = Math.max(1, Math.min(10, Math.floor(questionCount)));
        const effectiveQuestionCount: number = analysis.summary.estimatedMaxQuestions > 0
            ? Math.min(requestedQuestionCount, analysis.summary.estimatedMaxQuestions)
            : requestedQuestionCount;

        progress?.({
            phase: "planning",
            label: "正在规划知识点",
        });
        const planningStart = Date.now();
        const generatedBlueprint = await this.blueprintService.buildBlueprint(
            scopeLabel,
            eligibleChunks,
            analysis.profiles,
            effectiveQuestionCount,
            examMode,
            options.abortSignal,
            adaptivePlan?.targets.map((target) => ({
                conceptId: target.conceptId,
                label: target.label,
                sourceChunkIds: target.sourceChunkIds,
                expectedQuestionCount: target.expectedQuestionCount,
            })) ?? [],
        );
        const blueprint = adaptivePlan
            ? attachAdaptiveTargets(generatedBlueprint, adaptivePlan)
            : generatedBlueprint;
        durations.planningMs = Date.now() - planningStart;
        throwIfAborted(options.abortSignal);

        progress?.({
            phase: "generating",
            label: `正在生成题目 0 / ${blueprint.plannedQuestionCount}`,
            current: 0,
            total: blueprint.plannedQuestionCount,
        });
        const generationStart = Date.now();
        const generationResult: ExamQuestionGenerationResult = await this.questionGenerator.generateQuestions(
            blueprint,
            eligibleChunks,
            options.abortSignal,
            (current: number, total: number) => {
                progress?.({
                    phase: "generating",
                    label: `正在生成题目 ${current} / ${total}`,
                    current,
                    total,
                });
            },
            this.getConceptIdsByChunk(),
        );
        durations.generationMs = Date.now() - generationStart;
        durations.validationMs = durations.generationMs;
        throwIfAborted(options.abortSignal);

        const questions: ExamQuestion[] = generationResult.questions;
        if (questions.length === 0) {
            throw new Error("模型没有生成通过质量检查的可用题目。请减少题目数量、扩大范围，或关闭智能筛选后重试。");
        }

        progress?.({
            phase: "completed",
            label: "考试题目已生成",
            current: questions.length,
            total: blueprint.plannedQuestionCount,
        });

        const now: number = Date.now();
        const qualityNotice: string | undefined = questions.length < requestedQuestionCount
            ? `请求生成 ${requestedQuestionCount} 道题，其中 ${questions.length} 道通过范围与质量检查。为避免生成范围外或低质量题目，本次考试包含 ${questions.length} 道题。`
            : undefined;
        const diagnostics: ExamGenerationDiagnostics = {
            totalFiles: analysis.summary.totalFiles,
            ruleExcludedFiles: analysis.summary.ruleExcludedFiles,
            semanticExcludedFiles: analysis.summary.semanticExcludedFiles,
            partialFiles: analysis.summary.partialFiles,
            eligibleChunks: analysis.summary.eligibleChunkCount,
            requestedQuestions: requestedQuestionCount,
            plannedQuestions: blueprint.plannedQuestionCount,
            firstPassQuestions: generationResult.firstPassQuestions,
            repairedQuestions: generationResult.repairedQuestions,
            finalQuestions: questions.length,
            cacheHits: analysis.summary.cacheHits,
            cacheMisses: analysis.summary.cacheMisses,
            durations: {
                ...durations,
                scopeMs: durations.scopeMs,
                profilingMs: durations.profilingMs,
                planningMs: durations.planningMs,
                generationMs: durations.generationMs,
                validationMs: durations.validationMs,
            },
        };

        console.debug("[VaultCoach] Exam generation complete", {
            ...diagnostics,
            totalDurationMs: Date.now() - diagnosticsStart,
        });

        return {
            id: this.createExamId(now),
            title: `${scopeLabel} 测试`,
            createdAt: now,
            scopeLabel,
            selectedFolderPaths: [...selection.selectedFolderPaths],
            excludedFilePaths: [...selection.excludedFilePaths],
            forceIncludedFilePaths: [...selection.forceIncludedFilePaths],
            examMode,
            ...(adaptivePlan ? { adaptivePlan: createAdaptivePlanAuditSnapshot(adaptivePlan) } : {}),
            scopeSnapshot,
            analysisSummary: analysis.summary,
            blueprint,
            qualityNotice,
            diagnostics,
            questions,
            userAnswers: questions.map(() => ""),
            evaluation: null,
            savedPath: null,
            status: "draft",
        };
    }

    /**
     * 清空考试内容画像缓存。
     */
    async clearProfileCache(): Promise<void> {
        await this.profileStore.clear();
    }

    /**
     * 判断本次生成是否启用语义筛选。
     */
    private shouldUseSemanticFiltering(options: ExamGenerationOptions): boolean {
        if (options.skipSemanticFiltering) {
            return false;
        }

        return this.getSettings().enableExamSmartFiltering;
    }

    private assertAdaptivePlanCanGenerate(
        adaptivePlan: AdaptiveExamGenerationContext,
        examMode: ExamMode,
        eligibleChunkIds: readonly string[],
    ): void {
        if (adaptivePlan.examMode !== examMode) {
            throw new Error("自适应考试计划与当前考试模式不一致，请返回并重新分析。");
        }
        const validation = validateAdaptiveExamPlan({
            id: adaptivePlan.planId,
            algorithmVersion: adaptivePlan.algorithmVersion,
            inputFingerprint: adaptivePlan.inputFingerprint,
            revisionFingerprint: adaptivePlan.revisionFingerprint,
            planningAt: 0,
            examMode: adaptivePlan.examMode,
            targetMode: adaptivePlan.targetMode,
            scopeSignature: adaptivePlan.scopeSignature,
            revisions: adaptivePlan.revisions,
            targets: adaptivePlan.targets,
            appliedFallbacks: adaptivePlan.appliedFallbacks,
            diagnostics: {
                candidateConceptCount: adaptivePlan.targets.length,
                sourceBackedConceptCount: adaptivePlan.targets.length,
                excludedConceptIds: [],
                requestedQuestionCount: adaptivePlan.targets.reduce((total, target) => total + target.expectedQuestionCount, 0),
                plannedQuestionCount: adaptivePlan.targets.reduce((total, target) => total + target.expectedQuestionCount, 0),
            },
        });
        if (validation.length > 0) {
            throw new Error("自适应考试计划无效，请返回并重新分析。");
        }
        const scopedChunkIds = new Set(eligibleChunkIds);
        if (adaptivePlan.targets.some((target) => target.sourceChunkIds.some((chunkId) => !scopedChunkIds.has(chunkId)))) {
            throw new Error("自适应考试计划的证据范围已变化，请返回并重新分析。");
        }
    }

    /**
     * 构造仅基于手动范围的画像。
     *
     * 当用户关闭智能筛选或跳过语义分析时，候选文件默认全部 include。
     */
    private buildManualOnlyProfiles(resolvedScope: ExamResolvedScope): ExamContentProfile[] {
        return resolvedScope.candidateFiles.map((fileOption) => {
            const chunks: IndexedChunk[] = this.documentIndex.getChunksByFilePath(fileOption.filePath);
            return {
                filePath: fileOption.filePath,
                decision: "include",
                confidence: 1,
                reasonCodes: [],
                eligibleHeadingPaths: [],
                excludedHeadingPaths: [],
                topics: this.inferTopics(fileOption.fileName, chunks),
                estimatedQuestionCapacity: chunks.length > 0 ? Math.max(1, Math.min(10, Math.ceil(chunks.length / 2))) : 0,
            };
        });
    }

    /**
     * 从 chunk 标题中推断文件主题，用于手动画像和诊断展示。
     */
    private inferTopics(fileName: string, chunks: IndexedChunk[]): string[] {
        const topics: string[] = [];
        for (const chunk of chunks) {
            const topic: string = chunk.primaryHeading ?? chunk.headingPath[0] ?? fileName.replace(/\.md$/i, "");
            if (topic.length > 0) {
                topics.push(topic);
            }
        }

        if (topics.length === 0) {
            topics.push(fileName.replace(/\.md$/i, ""));
        }

        return Array.from(new Set(topics)).slice(0, 8);
    }

    /**
     * 生成稳定的考试 ID。
     */
    private createExamId(timestamp: number): string {
        return `exam_${new Date(timestamp).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    }
}

/**
 * Carries a plan's selected effective Concept IDs forward without teaching the
 * blueprint/model layer about graph services. Every item already has sources
 * restricted to the plan evidence set.
 */
function attachAdaptiveTargets(
    blueprint: import("../domain/exam/exam-types").ExamBlueprint,
    plan: AdaptiveExamGenerationContext,
): import("../domain/exam/exam-types").ExamBlueprint {
    const remainingByConceptId = new Map(plan.targets.map((target) => [target.conceptId, target.expectedQuestionCount]));
    return {
        ...blueprint,
        items: blueprint.items.map((item) => ({
            ...item,
            plannedTargetConceptIds: plan.targets
                .filter((target) => target.sourceChunkIds.some((chunkId) => item.sourceChunkIds.includes(chunkId)))
                .filter((target) => (remainingByConceptId.get(target.conceptId) ?? 0) > 0)
                .sort((left, right) => right.priority - left.priority || left.conceptId.localeCompare(right.conceptId))
                .slice(0, 1)
                .map((target) => target.conceptId)
                .map((conceptId) => {
                    remainingByConceptId.set(conceptId, (remainingByConceptId.get(conceptId) ?? 1) - 1);
                    return conceptId;
                }),
        })),
    };
}
