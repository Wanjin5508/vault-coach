import { describe, expect, it, vi } from "vitest";
import { ExamController, type ExamControllerEvent } from "../../src/presentation/controllers/exam-controller";
import type { VaultCoachPluginApi } from "../../src/presentation/plugin-api";
import type { ExamGenerationOptions, ExamScopeAnalysisResult, ExamSession } from "../../src/domain/exam/exam-types";

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolvePromise: ((value: T) => void) | null = null;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value: T): void {
            resolvePromise?.(value);
        },
    };
}

function createSession(questionCount = 1): ExamSession {
    return {
        id: "exam-1",
        title: "测试",
        createdAt: 1,
        scopeLabel: "完整知识库",
        selectedFolderPaths: [],
        excludedFilePaths: [],
        forceIncludedFilePaths: [],
        questions: Array.from({ length: questionCount }, (_value, index) => ({
            id: `question-${index + 1}`,
            blueprintItemId: `blueprint-${index + 1}`,
            question: "问题",
            referenceAnswer: "答案",
            rubric: "标准",
            questionType: "explanation" as const,
            difficulty: "basic" as const,
            sourceChunkIds: [],
            evidenceExcerptIds: [],
            sourcePaths: [],
            conceptIds: [],
            generationMetadata: {
                modelProvider: "ollama",
                modelName: "test-model",
                promptVersion: "test/v1",
                generatedAt: 1,
            },
        })),
        userAnswers: [],
        evaluation: null,
        savedPath: null,
        status: "draft",
    };
}

function createEvaluationItem(questionId = "question-1") {
    return {
        questionId,
        score: 80,
        maxScore: 100,
        feedback: "正确",
        improvement: "补充细节",
        coveredKeyPoints: [],
        missingKeyPoints: [],
        errorCodes: [],
        evaluationConfidence: 0,
        evaluator: {
            modelProvider: "ollama",
            modelName: "test-model",
            promptVersion: "test/v1",
            evaluatedAt: 1,
        },
    };
}

function createAnalysis(): ExamScopeAnalysisResult {
    return {
        selection: {
            selectedFolderPaths: [],
            excludedFilePaths: [],
            forceIncludedFilePaths: [],
        },
        profiles: [],
        summary: {
            totalFiles: 1,
            ruleExcludedFiles: 0,
            manualExcludedFiles: 0,
            semanticExcludedFiles: 0,
            partialFiles: 0,
            includedFiles: 1,
            eligibleChunkCount: 1,
            estimatedMinQuestions: 1,
            estimatedMaxQuestions: 1,
            cacheHits: 0,
            cacheMisses: 1,
        },
        eligibleChunkIds: ["chunk-1"],
        promptVersion: "test/v1",
    };
}

describe("ExamController", () => {
    it("prepares a visible, editable exam scope from Learning Map source files", () => {
        const getExamFileOptions = vi.fn(() => [
            { filePath: "notes/concept.md", fileName: "concept.md", parentFolder: "notes", chunkCount: 3, permanentlyExcluded: false },
            { filePath: "notes/other.md", fileName: "other.md", parentFolder: "notes", chunkCount: 2, permanentlyExcluded: false },
            { filePath: "notes/rule-excluded.md", fileName: "rule-excluded.md", parentFolder: "notes", chunkCount: 1, permanentlyExcluded: true },
        ]);
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [
                { id: "__all__", label: "All", folderPath: null, fileCount: 3, chunkCount: 6 },
                { id: "notes", label: "notes", folderPath: "notes", fileCount: 3, chunkCount: 6 },
            ],
            getExamFileOptions,
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);

        expect(controller.prepareSourceScopedExam(["notes/concept.md", "notes/rule-excluded.md"])).toBe(true);
        expect(getExamFileOptions).toHaveBeenCalledWith([]);
        expect(controller.getState()).toMatchObject({ phase: "setup", showFileManager: true });
        expect(controller.getState().selectedScopeIds).toEqual(new Set(["notes"]));
        expect(controller.getState().forceIncludedFilePaths).toEqual(new Set(["notes/concept.md"]));
        expect(controller.getState().excludedFilePaths).toEqual(new Set(["notes/other.md", "notes/rule-excluded.md"]));
        expect(controller.getScopeSelection().selectedFolderPaths).toEqual(["notes"]);
        expect(getExamFileOptions).toHaveBeenCalledWith(["notes"]);

        expect(controller.prepareSourceScopedExam(["missing.md", "notes/rule-excluded.md"])).toBe(false);
        expect(controller.getState().forceIncludedFilePaths).toEqual(new Set(["notes/concept.md"]));
    });

    it("owns exam generation state, progress, and final cleanup", async () => {
        const deferred = createDeferred<ExamSession>();
        const createExamSession = vi.fn((_selection, _questionCount: number, options?: ExamGenerationOptions) => {
            options?.onProgress?.({ phase: "planning", label: "planning" });
            return deferred.promise;
        });
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [],
            createExamSession,
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);
        const events: ExamControllerEvent[] = [];
        controller.subscribe((event) => {
            events.push(event);
        });

        const creating = controller.createExam(false);
        await vi.waitFor(() => expect(createExamSession).toHaveBeenCalledOnce());

        expect(controller.getState()).toMatchObject({ busy: true, phase: "generating", progressLabel: "exam.progress.planning" });
        const options = createExamSession.mock.calls[0]?.[2] as ExamGenerationOptions;
        expect(options.abortSignal).toBeInstanceOf(AbortSignal);
        expect(options.skipSemanticFiltering).toBe(false);
        expect(options.examMode).toBe("simple");

        deferred.resolve(createSession());
        await creating;

        expect(controller.getState()).toMatchObject({ busy: false, phase: "taking", progressLabel: "" });
        expect(controller.getState().session?.id).toBe("exam-1");
        expect(events.some((event) => event.type === "notice" && event.key === "exam.notice.questionCountReduced")).toBe(true);
    });

    it("switches the generation policy to challenge mode without changing the selected scope", () => {
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [],
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);

        controller.setExamMode("challenge");

        expect(controller.getState()).toMatchObject({ examMode: "challenge", phase: "setup" });
        expect(controller.getScopeSelection()).toEqual({
            selectedFolderPaths: [],
            excludedFilePaths: [],
            forceIncludedFilePaths: [],
        });
    });

    it("locks the analyzed mode until the user explicitly returns to setup", async () => {
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [],
            analyzeExamScope: vi.fn(async () => createAnalysis()),
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);

        controller.setExamMode("challenge");
        await controller.analyzeScope(false);
        controller.setExamMode("simple");

        const analyzedState = controller.getState();
        expect(analyzedState.examMode).toBe("challenge");
        expect(analyzedState.analysis).not.toBeNull();

        controller.returnToSetup();
        controller.setExamMode("simple");

        expect(controller.getState()).toMatchObject({ examMode: "simple", analysis: null, phase: "setup" });
    });

    it("locks the adaptive target together with the exam mode after analysis", async () => {
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [],
            analyzeExamScope: vi.fn(async () => createAnalysis()),
            previewAdaptiveExamPlan: vi.fn(async () => ({
                status: "unavailable" as const,
                reasonCode: "no-effective-concepts" as const,
                message: "No plan",
            })),
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);

        controller.setAdaptiveTargetMode("mixed");
        await controller.analyzeScope(false);
        controller.setAdaptiveTargetMode("prerequisite");

        expect(controller.getState().adaptiveTargetMode).toBe("mixed");
        expect(controller.getState().analysis).not.toBeNull();
        controller.returnToSetup();
        controller.setAdaptiveTargetMode("prerequisite");
        expect(controller.getState().adaptiveTargetMode).toBe("prerequisite");
    });

    it("cancels scope analysis and restores a usable setup state", async () => {
        const analyzeExamScope = vi.fn((_selection, options?: ExamGenerationOptions) => {
            return new Promise<never>((_resolve, reject) => {
                options?.abortSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
        });
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [],
            analyzeExamScope,
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);
        const events: ExamControllerEvent[] = [];
        controller.subscribe((event) => {
            events.push(event);
        });

        const analyzing = controller.analyzeScope(false);
        await vi.waitFor(() => expect(analyzeExamScope).toHaveBeenCalledOnce());
        controller.cancelActiveOperation();
        await analyzing;

        const options = analyzeExamScope.mock.calls[0]?.[1] as ExamGenerationOptions;
        expect(options.abortSignal?.aborted).toBe(true);
        expect(controller.getState()).toMatchObject({ busy: false, phase: "setup", progressLabel: "" });
        expect(events.some((event) => event.type === "notice" && event.key === "exam.notice.cancelled")).toBe(true);
    });

    it("submits answers, saves the evaluated session, and keeps the controller state authoritative", async () => {
        const evaluatedSession: ExamSession = {
            ...createSession(),
            userAnswers: ["用户答案"],
            evaluation: {
                score: 80,
                maxScore: 100,
                overallFeedback: "不错",
                items: [createEvaluationItem()],
            },
            status: "submitted",
        };
        const evaluateExamSession = vi.fn(async () => evaluatedSession);
        const saveExamSession = vi.fn(async (session: ExamSession) => ({ ...session, savedPath: "VaultCoach Exams/exam.md", status: "saved" as const }));
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [],
            createExamSession: vi.fn(async () => createSession()),
            evaluateExamSession,
            saveExamSession,
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);
        const state = controller.getState();
        await controller.createExam(false);
        controller.setAnswer(0, "用户答案");
        await controller.submitAnswers(["用户答案"]);

        expect(evaluateExamSession).toHaveBeenCalledWith(expect.objectContaining({ userAnswers: ["用户答案"] }), ["用户答案"]);
        expect(saveExamSession).toHaveBeenCalledOnce();
        expect(controller.getState()).toMatchObject({ busy: false, phase: "review" });
        expect(controller.getState().session?.savedPath).toBe("VaultCoach Exams/exam.md");
        expect(state.session).toBeNull();
    });

    it("keeps the evaluated session available when automatic saving fails", async () => {
        const evaluatedSession: ExamSession = {
            ...createSession(),
            userAnswers: ["用户答案"],
            evaluation: {
                score: 80,
                maxScore: 100,
                overallFeedback: "不错",
                items: [createEvaluationItem()],
            },
            status: "submitted",
        };
        const saveError = new Error("disk unavailable");
        const errorLogger = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const evaluateExamSession = vi.fn(async () => evaluatedSession);
        const saveExamSession = vi.fn(async () => Promise.reject(saveError));
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [],
            createExamSession: vi.fn(async () => createSession()),
            evaluateExamSession,
            saveExamSession,
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);
        const events: ExamControllerEvent[] = [];
        controller.subscribe((event) => {
            events.push(event);
        });

        await controller.createExam(false);
        await controller.submitAnswers(["用户答案"]);

        expect(evaluateExamSession).toHaveBeenCalledOnce();
        expect(saveExamSession).toHaveBeenCalledWith(evaluatedSession);
        expect(controller.getState()).toMatchObject({ busy: false, phase: "review", session: evaluatedSession });
        expect(controller.getState().session?.savedPath).toBeNull();
        expect(events.some((event) => event.type === "notice" && event.key === "exam.notice.saveFailed")).toBe(true);
        expect(errorLogger).toHaveBeenCalledWith("[VaultCoachExamController] 自动保存考试结果失败", saveError);
    });

    it("keeps history UI calls path-agnostic for structured and legacy records", async () => {
        const structuredPath = ".vault-coach/assessments/sessions/exam-1.json";
        const listExamHistory = vi.fn(async () => [{
            path: structuredPath,
            title: "结构化记录",
            createdAt: 1,
            score: 80,
            maxScore: 100,
            modifiedAt: 1,
        }]);
        const readExamHistoryContent = vi.fn(async () => "由 JSON 重建的报告");
        const deleteExamHistory = vi.fn(async () => undefined);
        const api = {
            settings: { enableExamSmartFiltering: true },
            listExamHistory,
            readExamHistoryContent,
            deleteExamHistory,
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);

        await controller.showHistory();
        await controller.loadHistory(structuredPath);
        await controller.deleteHistory(structuredPath);

        expect(readExamHistoryContent).toHaveBeenCalledWith(structuredPath);
        expect(deleteExamHistory).toHaveBeenCalledWith(structuredPath);
        expect(listExamHistory).toHaveBeenCalledTimes(2);
        expect(controller.getState()).toMatchObject({ phase: "history", selectedHistoryPath: null, selectedHistoryContent: "" });
    });

    it("returns to answer-taking and does not save when evaluation fails", async () => {
        const evaluationError = new Error("model unavailable");
        const errorLogger = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const evaluateExamSession = vi.fn(async () => Promise.reject(evaluationError));
        const saveExamSession = vi.fn(async (session: ExamSession) => session);
        const api = {
            settings: { enableExamSmartFiltering: true },
            getExamScopeOptions: () => [],
            createExamSession: vi.fn(async () => createSession()),
            evaluateExamSession,
            saveExamSession,
        } as unknown as VaultCoachPluginApi;
        const controller = new ExamController(api, (key) => key);
        const events: ExamControllerEvent[] = [];
        controller.subscribe((event) => {
            events.push(event);
        });

        await controller.createExam(false);
        await controller.submitAnswers(["用户答案"]);

        expect(evaluateExamSession).toHaveBeenCalledOnce();
        expect(saveExamSession).not.toHaveBeenCalled();
        expect(controller.getState()).toMatchObject({ busy: false, phase: "taking" });
        expect(controller.getState().session?.userAnswers).toEqual(["用户答案"]);
        expect(events.some((event) => event.type === "notice" && event.key === "exam.notice.evaluateFailed")).toBe(true);
        expect(errorLogger).toHaveBeenCalledWith("[VaultCoachExamController] 考试评分失败", evaluationError);
    });
});
