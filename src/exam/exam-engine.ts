import { App } from "obsidian";
import { VaultKnowledgeBase } from "../knowledge-base";
import { LocalModelClient } from "../model-client";
import type {
    ExamContentProfile,
    ExamGenerationDiagnostics,
    ExamGenerationOptions,
    ExamQuestion,
    ExamScopeAnalysisResult,
    ExamScopeSnapshot,
    ExamScopeSelection,
    ExamSession,
    IndexedChunk,
    VaultCoachSettings,
} from "../types";
import { ExamBlueprintService } from "./exam-blueprint-service";
import { ExamContentProfiler, EXAM_CONTENT_PROFILE_PROMPT_VERSION } from "./exam-content-profiler";
import { ExamQuestionGenerator, ExamQuestionGenerationResult } from "./exam-question-generator";
import { ExamQuestionValidator } from "./exam-question-validator";
import { ExamProfileStore } from "./exam-profile-store";
import { ExamResolvedScope, ExamScopeService } from "./exam-scope-service";
import { throwIfAborted } from "./exam-utils";

export class ExamEngine {
    private readonly knowledgeBase: VaultKnowledgeBase;
    private readonly getSettings: () => VaultCoachSettings;
    private readonly client: LocalModelClient;
    private readonly profileStore: ExamProfileStore;
    private readonly scopeService: ExamScopeService;
    private readonly profiler: ExamContentProfiler;
    private readonly blueprintService: ExamBlueprintService;
    private readonly questionGenerator: ExamQuestionGenerator;

    constructor(
        app: App,
        knowledgeBase: VaultKnowledgeBase,
        getSettings: () => VaultCoachSettings,
        getCloudApiKey: () => string | null,
    ) {
        this.knowledgeBase = knowledgeBase;
        this.getSettings = getSettings;
        this.client = new LocalModelClient(getSettings, getCloudApiKey);
        this.profileStore = new ExamProfileStore(app);
        this.scopeService = new ExamScopeService(knowledgeBase);
        this.profiler = new ExamContentProfiler(knowledgeBase, this.client, this.profileStore, getSettings);
        this.blueprintService = new ExamBlueprintService(this.client);
        this.questionGenerator = new ExamQuestionGenerator(
            this.client,
            new ExamQuestionValidator(),
            getSettings,
        );
    }

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

    async createExamSession(
        scopeLabel: string,
        selection: ExamScopeSelection,
        questionCount: number,
        scopeSnapshot: ExamScopeSnapshot,
        options: ExamGenerationOptions = {},
    ): Promise<ExamSession> {
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

        const eligibleChunks: IndexedChunk[] = this.knowledgeBase.getExamChunksByIds(analysis.eligibleChunkIds);
        if (eligibleChunks.length === 0) {
            throw new Error("当前考试范围内没有通过规则和智能筛选的可用片段。");
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
        const blueprint = await this.blueprintService.buildBlueprint(
            scopeLabel,
            eligibleChunks,
            analysis.profiles,
            effectiveQuestionCount,
            options.abortSignal,
        );
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

    async clearProfileCache(): Promise<void> {
        await this.profileStore.clear();
    }

    private shouldUseSemanticFiltering(options: ExamGenerationOptions): boolean {
        if (options.skipSemanticFiltering) {
            return false;
        }

        return this.getSettings().enableExamSmartFiltering;
    }

    private buildManualOnlyProfiles(resolvedScope: ExamResolvedScope): ExamContentProfile[] {
        return resolvedScope.candidateFiles.map((fileOption) => {
            const chunks: IndexedChunk[] = this.knowledgeBase.getExamFileChunks(fileOption.filePath);
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

    private createExamId(timestamp: number): string {
        return `exam_${new Date(timestamp).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    }
}
