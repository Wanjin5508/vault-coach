import { describe, expect, it, vi } from "vitest";
import { VaultCoachApplication, type VaultCoachApplicationDependencies } from "../../src/app/vault-coach-application";
import { AssessmentEventFactory } from "../../src/domain/assessment/assessment-event-factory";
import type { AssessmentSessionDocumentV1 } from "../../src/domain/assessment/assessment-types";
import type { ExamEvaluation, ExamSession } from "../../src/domain/exam/exam-types";

describe("VaultCoachApplication", () => {
    it("publishes grouped chat use-case events without a presentation dependency", async () => {
        const appendUserMessage = vi.fn(async () => undefined);
        const application = new VaultCoachApplication({
            chatService: {
                getMessages: () => [],
                appendUserMessage,
                streamAssistantTurn: async () => ({ text: "回答", sources: [], retrievalModeUsed: "keyword", rewriteResult: { originalQuery: "", rewrittenQuery: "", useRewrite: false } }),
                resetConversation: () => undefined,
            },
        } as unknown as VaultCoachApplicationDependencies);
        const events: string[] = [];
        const unsubscribe = application.subscribe((event) => events.push(event.type));

        await application.chat.appendUserMessage("问题");
        application.chat.resetConversation();
        unsubscribe();

        expect(appendUserMessage).toHaveBeenCalledWith("问题");
        expect(events).toEqual(["conversation-changed", "conversation-changed"]);
        expect(application.progress.isAvailable()).toBe(false);
    });

    it("persists assessment facts before the Markdown projection and then notifies history", async () => {
        const harness = createExamSaveHarness();
        const events: string[] = [];
        harness.application.subscribe((event) => events.push(event.type));

        const saved = await harness.application.exam.saveSession(createScoredSession());

        expect(saved).toMatchObject({ status: "saved", savedPath: ".vault-coach/exams/session-1-结构化证据测试.md" });
        expect(harness.callOrder).toEqual(["facts", "report"]);
        expect(events).toEqual(["exam-history-changed"]);
        expect(harness.documents.get("session-1")).toMatchObject({
            schemaVersion: 1,
            sessionId: "session-1",
            examSession: { status: "saved" },
            assessmentEvents: [{ id: "event-1", questionId: "q1", rawScore: 80 }],
        });
    });

    it("does not write a Markdown report or notify history when JSON facts fail", async () => {
        const factsError = new Error("facts unavailable");
        const harness = createExamSaveHarness({ saveFactsError: factsError });
        const events: string[] = [];
        harness.application.subscribe((event) => events.push(event.type));

        await expect(harness.application.exam.saveSession(createScoredSession())).rejects.toThrow(factsError);

        expect(harness.writeAssessmentProjection).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect(harness.callOrder).toEqual(["facts"]);
    });

    it("retains saved JSON facts but does not notify history when Markdown projection fails", async () => {
        const reportError = new Error("report unavailable");
        const harness = createExamSaveHarness({ writeReportError: reportError });
        const events: string[] = [];
        harness.application.subscribe((event) => events.push(event.type));

        await expect(harness.application.exam.saveSession(createScoredSession())).rejects.toThrow(reportError);

        expect(harness.documents.get("session-1")?.assessmentEvents).toHaveLength(1);
        expect(events).toEqual([]);
        expect(harness.callOrder).toEqual(["facts", "report"]);
    });

    it("keeps automatic repeated saving idempotent and appends only a real re-evaluation", async () => {
        const harness = createExamSaveHarness();
        const first = createScoredSession();

        await harness.application.exam.saveSession(first);
        await harness.application.exam.saveSession(first);

        expect(harness.saveAssessmentDocument).toHaveBeenCalledOnce();
        expect(harness.documents.get("session-1")?.assessmentEvents).toHaveLength(1);

        const reEvaluated = createScoredSession({ score: 92, evaluatedAt: 200 });
        await harness.application.exam.saveSession(reEvaluated);

        const events = harness.documents.get("session-1")?.assessmentEvents ?? [];
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({ id: "event-2", rawScore: 92, supersedesEventId: "event-1" });
        expect(harness.saveAssessmentDocument).toHaveBeenCalledTimes(2);
        expect(harness.writeAssessmentProjection).toHaveBeenCalledTimes(3);
    });

    it("keeps submitSession report-free until the existing caller performs its automatic save", async () => {
        const evaluation = createEvaluation();
        const harness = createExamSaveHarness({ evaluate: vi.fn(async () => evaluation) });
        const draft = { ...createScoredSession(), evaluation: null, status: "draft" as const };

        const submitted = await harness.application.exam.submitSession(draft, ["检索增强生成"]);
        expect(harness.saveAssessmentDocument).not.toHaveBeenCalled();

        await harness.application.exam.saveSession(submitted);

        expect(harness.saveAssessmentDocument).toHaveBeenCalledOnce();
        expect(harness.writeAssessmentProjection).toHaveBeenCalledOnce();
    });
});

interface ExamSaveHarnessOptions {
    saveFactsError?: Error;
    writeReportError?: Error;
    evaluate?: ReturnType<typeof vi.fn>;
}

function createExamSaveHarness(options: ExamSaveHarnessOptions = {}) {
    const documents = new Map<string, AssessmentSessionDocumentV1>();
    const callOrder: string[] = [];
    const saveAssessmentDocument = vi.fn(async (document: AssessmentSessionDocumentV1) => {
        callOrder.push("facts");
        if (options.saveFactsError) {
            throw options.saveFactsError;
        }
        documents.set(document.sessionId, document);
    });
    const writeAssessmentProjection = vi.fn(async (document: AssessmentSessionDocumentV1) => {
        callOrder.push("report");
        if (options.writeReportError) {
            throw options.writeReportError;
        }
        return document.examSession;
    });
    const eventIds = ["event-1", "event-2", "event-3"];
    const application = new VaultCoachApplication({
        chatService: {
            getMessages: () => [],
            appendUserMessage: async () => undefined,
            streamAssistantTurn: async () => ({ text: "", sources: [], retrievalModeUsed: "keyword", rewriteResult: { originalQuery: "", rewrittenQuery: "", useRewrite: false } }),
            resetConversation: () => undefined,
        },
        examEvaluationService: {
            evaluate: options.evaluate ?? vi.fn(async () => createEvaluation()),
        },
        examSessionStore: {
            save: vi.fn(async (session: ExamSession) => ({ ...session, savedPath: ".vault-coach/exams/legacy.md", status: "saved" as const })),
            prepareSessionForSave: (session: ExamSession) => ({
                ...session,
                savedPath: session.savedPath ?? `.vault-coach/exams/${session.id}-${session.title}.md`,
                status: "saved" as const,
            }),
            writeAssessmentProjection,
        },
        assessmentSessionStore: {
            read: async (sessionId: string) => documents.get(sessionId) ?? null,
            save: saveAssessmentDocument,
        },
        assessmentEventFactory: new AssessmentEventFactory({
            createEventId: () => eventIds.shift() ?? "unexpected-event-id",
        }),
        getAssessmentSavedAt: () => 1000,
        getAssessmentSessionPath: (sessionId: string) => `.vault-coach/assessments/sessions/${sessionId}.json`,
        getExamEvaluationMetadata: () => ({
            modelProvider: "ollama",
            modelName: "evaluation-model",
            promptVersion: "evaluation/v2",
            evaluatedAt: 100,
        }),
    } as unknown as VaultCoachApplicationDependencies);

    return {
        application,
        documents,
        callOrder,
        saveAssessmentDocument,
        writeAssessmentProjection,
    };
}

function createScoredSession(overrides: { score?: number; evaluatedAt?: number } = {}): ExamSession {
    const evaluation = createEvaluation(overrides);
    return {
        id: "session-1",
        title: "结构化证据测试",
        createdAt: 1,
        scopeLabel: "完整知识库",
        selectedFolderPaths: [],
        excludedFilePaths: [],
        forceIncludedFilePaths: [],
        questions: [{
            id: "q1",
            blueprintItemId: "bp-rag",
            question: "什么是 RAG？",
            referenceAnswer: "检索增强生成。",
            rubric: "100 分制。",
            questionType: "explanation",
            difficulty: "basic",
            sourceChunkIds: ["chunk-rag"],
            evidenceExcerptIds: ["E1"],
            sourcePaths: ["notes/rag.md"],
            conceptIds: ["exam-topic:rag"],
            generationMetadata: {
                modelProvider: "ollama",
                modelName: "question-model",
                promptVersion: "question/v1",
                generatedAt: 1,
            },
        }],
        userAnswers: ["检索增强生成"],
        evaluation,
        savedPath: null,
        status: "submitted",
    };
}

function createEvaluation(overrides: { score?: number; evaluatedAt?: number } = {}): ExamEvaluation {
    const score = overrides.score ?? 80;
    return {
        score,
        maxScore: 100,
        overallFeedback: "完成。",
        items: [{
            questionId: "q1",
            score,
            maxScore: 100,
            feedback: "正确。",
            improvement: "补充例子。",
            coveredKeyPoints: ["检索增强生成"],
            missingKeyPoints: [],
            errorCodes: [],
            evaluationConfidence: 0.9,
            evaluator: {
                modelProvider: "ollama",
                modelName: "evaluation-model",
                promptVersion: "evaluation/v2",
                evaluatedAt: overrides.evaluatedAt ?? 100,
            },
        }],
    };
}
