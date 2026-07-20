import { describe, expect, it, vi } from "vitest";
import { ChatService, type ChatServiceDependencies } from "../../src/app/chat/chat-service";
import type { ChatMessage, StreamHandlers } from "../../src/app/chat/chat-types";
import { VaultCoachApplication, type VaultCoachApplicationDependencies } from "../../src/app/vault-coach-application";
import type { VaultCoachSettings } from "../../src/app/config/settings-types";
import { AssessmentEventFactory } from "../../src/domain/assessment/assessment-event-factory";
import type { AssessmentSessionDocumentV1 } from "../../src/domain/assessment/assessment-types";
import type { ExamScopeSelection, ExamSession } from "../../src/domain/exam/exam-types";

function createSession(): ExamSession {
    return {
        id: "exam-integration",
        title: "集成测试",
        createdAt: 1,
        scopeLabel: "完整知识库",
        selectedFolderPaths: [],
        excludedFilePaths: [],
        forceIncludedFilePaths: [],
        questions: [{
            id: "q1",
            blueprintItemId: "bp-rag",
            question: "什么是 RAG？",
            referenceAnswer: "检索增强生成",
            rubric: "说明检索与生成",
            questionType: "explanation",
            difficulty: "basic",
            sourceChunkIds: ["chunk-rag"],
            evidenceExcerptIds: ["E1"],
            sourcePaths: ["notes/rag.md"],
            conceptIds: ["exam-topic:rag"],
            generationMetadata: {
                modelProvider: "ollama",
                modelName: "test-model",
                promptVersion: "test/v1",
                generatedAt: 1,
            },
        }],
        userAnswers: [],
        evaluation: null,
        savedPath: null,
        status: "draft",
    };
}

function createChatService(): { chatService: ChatService; persist: ReturnType<typeof vi.fn>; streamAnswerQuestion: ReturnType<typeof vi.fn> } {
    const chatService = new ChatService(() => ({ defaultRetrievalMode: "hybrid", maxConversationMessages: 10 } as VaultCoachSettings));
    const persist = vi.fn(async () => undefined);
    const streamAnswerQuestion = vi.fn(async (
        _question: string,
        _messages: ChatMessage[],
        _scope: string,
        _memory: string,
        handlers?: StreamHandlers,
    ) => {
        handlers?.onToken?.("检索");
        handlers?.onToken?.("回答");
        return {
            text: "检索回答",
            sources: [],
            retrievalModeUsed: "hybrid" as const,
            queryRewrite: { originalQuery: "问题", rewrittenQuery: "问题", useRewrite: false },
        };
    });
    chatService.setDependencies({
        ragEngine: { streamAnswerQuestion },
        memoryService: {
            buildContext: () => "",
            updateFromAssistantTurn: async () => undefined,
        },
        ensureKnowledgeBaseReady: async () => undefined,
        getKnowledgeScopeDescription: () => "测试知识库",
        persist,
        getDefaultGreeting: () => "你好",
        onGenerationFinished: () => undefined,
    } as unknown as ChatServiceDependencies);
    return { chatService, persist, streamAnswerQuestion };
}

describe("VaultCoachApplication integration", () => {
    it("runs the chat flow with fake RAG and publishes presentation events", async () => {
        const { chatService, persist, streamAnswerQuestion } = createChatService();
        const application = new VaultCoachApplication({ chatService } as unknown as VaultCoachApplicationDependencies);
        const events: string[] = [];
        application.subscribe((event) => events.push(event.type));
        const tokens: string[] = [];

        await application.chat.appendUserMessage("问题");
        const answer = await application.chat.streamAssistantTurn("问题", { onToken: (token) => tokens.push(token) });

        expect(answer.text).toBe("检索回答");
        expect(streamAnswerQuestion).toHaveBeenCalledOnce();
        expect(tokens).toEqual(["检索", "回答"]);
        expect(chatService.getMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(persist).toHaveBeenCalledTimes(2);
        expect(events).toEqual(["conversation-changed", "conversation-changed"]);
    });

    it("runs the exam create, evaluate, save, and history flow with fake ports", async () => {
        const { chatService } = createChatService();
        const ensureKnowledgeBaseReady = vi.fn(async () => undefined);
        const createExamSession = vi.fn(async () => createSession());
        const evaluate = vi.fn(async () => ({
            score: 90,
            maxScore: 100,
            overallFeedback: "回答完整",
            items: [{
                questionId: "q1",
                score: 90,
                maxScore: 100,
                feedback: "很好",
                improvement: "补充例子",
                coveredKeyPoints: ["检索增强生成"],
                missingKeyPoints: [],
                errorCodes: [],
                evaluationConfidence: 0.9,
                evaluator: {
                    modelProvider: "ollama",
                    modelName: "test-model",
                    promptVersion: "exam-evaluation/test",
                    evaluatedAt: 1,
                },
            }],
        }));
        const savedSession: ExamSession = { ...createSession(), savedPath: ".vault-coach/exams/exam-integration.md", status: "saved" };
        const save = vi.fn(async () => savedSession);
        const assessmentDocuments = new Map<string, AssessmentSessionDocumentV1>();
        const saveAssessmentDocument = vi.fn(async (document: AssessmentSessionDocumentV1) => {
            assessmentDocuments.set(document.sessionId, document);
        });
        const writeAssessmentProjection = vi.fn(async (document: AssessmentSessionDocumentV1) => document.examSession);
        const listHistory = vi.fn(async () => [{
            path: savedSession.savedPath!,
            title: savedSession.title,
            createdAt: savedSession.createdAt,
            score: 90,
            maxScore: 100,
            modifiedAt: 1,
        }]);
        const application = new VaultCoachApplication({
            chatService,
            examEngine: {
                getFileOptions: () => [],
                getScopeSnapshot: () => ({
                    totalFileCount: 1,
                    eligibleFileCount: 1,
                    excludedFileCount: 0,
                    eligibleChunkCount: 1,
                    estimatedMinQuestions: 1,
                    estimatedMaxQuestions: 3,
                }),
                hasEligibleChunks: () => true,
                createExamSession,
            },
            examEvaluationService: { evaluate },
            examSessionStore: {
                save,
                listHistory,
                prepareSessionForSave: (session: ExamSession) => ({ ...session, savedPath: ".vault-coach/exams/exam-integration.md", status: "saved" as const }),
                writeAssessmentProjection,
            },
            assessmentSessionStore: {
                read: async (sessionId: string) => assessmentDocuments.get(sessionId) ?? null,
                save: saveAssessmentDocument,
            },
            assessmentEventFactory: new AssessmentEventFactory({ createEventId: () => "event-integration" }),
            getAssessmentSavedAt: () => 2,
            getAssessmentSessionPath: (sessionId: string) => `.vault-coach/assessments/sessions/${sessionId}.json`,
            getScopeOptions: () => [{ id: "__all__", label: "完整知识库", folderPath: null, fileCount: 1, chunkCount: 1 }],
            normalizeFolderPaths: (paths: string[]) => paths,
            normalizeSelection: (selection: ExamScopeSelection) => selection,
            ensureKnowledgeBaseReady,
            getFullScopeLabel: () => "完整知识库",
            getNoEligibleChunksMessage: () => "没有可用片段",
            getExamEvaluationMetadata: () => ({
                modelProvider: "ollama",
                modelName: "test-model",
                promptVersion: "exam-evaluation/test",
                evaluatedAt: 1,
            }),
        } as unknown as VaultCoachApplicationDependencies);
        const events: string[] = [];
        application.subscribe((event) => events.push(event.type));
        const selection = { selectedFolderPaths: [], excludedFilePaths: [], forceIncludedFilePaths: [] };

        expect(application.exam.getScopeOptions()).toHaveLength(1);
        const created = await application.exam.createSession(selection, 5);
        const submitted = await application.exam.submitSession(created, ["检索增强生成"]);
        const saved = await application.exam.saveSession(submitted);
        const history = await application.exam.listHistory();

        expect(ensureKnowledgeBaseReady).toHaveBeenCalledOnce();
        expect(createExamSession).toHaveBeenCalledWith("完整知识库", selection, 3, expect.objectContaining({ estimatedMaxQuestions: 3 }), {});
        expect(evaluate).toHaveBeenCalledWith(created, ["检索增强生成"], {
            modelProvider: "ollama",
            modelName: "test-model",
            promptVersion: "exam-evaluation/test",
            evaluatedAt: 1,
        });
        expect(submitted).toMatchObject({ status: "submitted", userAnswers: ["检索增强生成"], evaluation: { score: 90 } });
        expect(save).not.toHaveBeenCalled();
        expect(saveAssessmentDocument).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "exam-integration",
            assessmentEvents: [expect.objectContaining({ id: "event-integration" })],
        }));
        expect(writeAssessmentProjection).toHaveBeenCalledOnce();
        expect(saved.savedPath).toBe(".vault-coach/exams/exam-integration.md");
        expect(history).toHaveLength(1);
        expect(events).toEqual(["exam-history-changed"]);
    });
});
