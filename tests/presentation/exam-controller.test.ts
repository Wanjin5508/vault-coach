import { describe, expect, it, vi } from "vitest";
import { ExamController, type ExamControllerEvent } from "../../src/presentation/controllers/exam-controller";
import type { VaultCoachPluginApi } from "../../src/presentation/plugin-api";
import type { ExamGenerationOptions, ExamSession } from "../../src/domain/exam/exam-types";

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
            question: "问题",
            referenceAnswer: "答案",
            rubric: "标准",
            sourcePaths: [],
        })),
        userAnswers: [],
        evaluation: null,
        savedPath: null,
        status: "draft",
    };
}

describe("ExamController", () => {
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

        deferred.resolve(createSession());
        await creating;

        expect(controller.getState()).toMatchObject({ busy: false, phase: "taking", progressLabel: "" });
        expect(controller.getState().session?.id).toBe("exam-1");
        expect(events.some((event) => event.type === "notice" && event.key === "exam.notice.questionCountReduced")).toBe(true);
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
                items: [{ questionId: "question-1", score: 80, maxScore: 100, feedback: "正确", improvement: "补充细节" }],
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
});
