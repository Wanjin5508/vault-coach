import { describe, expect, it, vi } from "vitest";
import { VaultCoachApplication, type VaultCoachApplicationDependencies } from "../../src/app/vault-coach-application";
import { AssessmentEventFactory } from "../../src/domain/assessment/assessment-event-factory";
import { DeterministicGraphBuilder } from "../../src/domain/graph/deterministic-graph-builder";
import { KnowledgeGraphService, type GraphSourceReader } from "../../src/app/graph/knowledge-graph-service";
import type { GraphStore } from "../../src/domain/graph/graph-store";
import type { GraphSnapshotV1, GraphSourceDocument } from "../../src/domain/graph/graph-types";
import type { AssessmentExamHistoryItem, AssessmentSessionDocumentV1 } from "../../src/domain/assessment/assessment-types";
import type { ExamEvaluation, ExamSession } from "../../src/domain/exam/exam-types";
import type { MarkdownExamHistoryRecord } from "../../src/exam/exam-session-store";
import type { MasteryService } from "../../src/app/mastery/mastery-service";
import type { ProgressService } from "../../src/app/progress/progress-service";

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

    it("exposes the Progress read model only through the application facade", async () => {
        const progressSnapshot = { marker: "progress-read-model" };
        const getSnapshot = vi.fn(async () => progressSnapshot);
        const application = new VaultCoachApplication({
            chatService: {
                getMessages: () => [],
                appendUserMessage: async () => undefined,
                streamAssistantTurn: async () => ({ text: "", sources: [], retrievalModeUsed: "keyword", rewriteResult: { originalQuery: "", rewrittenQuery: "", useRewrite: false } }),
                resetConversation: () => undefined,
            },
            progressService: { getSnapshot } as unknown as ProgressService,
        } as unknown as VaultCoachApplicationDependencies);

        expect(application.progress.isAvailable()).toBe(true);
        await expect(application.progress.getSnapshot()).resolves.toBe(progressSnapshot);
        expect(getSnapshot).toHaveBeenCalledOnce();
    });

    it("publishes semantic graph state immediately when a rebuild starts and again when it finishes", async () => {
        let busy = false;
        let completeRebuild: (() => void) | undefined;
        const rebuildAll = vi.fn(async () => {
            busy = true;
            await new Promise<void>((resolve) => { completeRebuild = resolve; });
            busy = false;
        });
        const application = new VaultCoachApplication({
            chatService: {
                getMessages: () => [],
                appendUserMessage: async () => undefined,
                streamAssistantTurn: async () => ({ text: "", sources: [], retrievalModeUsed: "keyword", rewriteResult: { originalQuery: "", rewrittenQuery: "", useRewrite: false } }),
                resetConversation: () => undefined,
            },
            semanticGraphService: {
                rebuildAll,
                getState: () => ({ busy }),
            },
        } as unknown as VaultCoachApplicationDependencies);
        const events: string[] = [];
        application.subscribe((event) => events.push(event.type));

        const rebuilding = application.semanticGraph.rebuild();

        expect(application.semanticGraph.getState().busy).toBe(true);
        expect(events).toEqual(["semantic-graph-state-changed"]);
        completeRebuild?.();
        await rebuilding;

        expect(events).toEqual([
            "semantic-graph-state-changed",
            "semantic-graph-state-changed",
        ]);
    });

    it("exposes graph rebuild and read APIs without leaking mutable snapshot state", async () => {
        const store = new ApplicationGraphStore();
        const graphService = new KnowledgeGraphService(createApplicationGraphReader(), new DeterministicGraphBuilder(), store);
        const application = new VaultCoachApplication({
            chatService: {
                getMessages: () => [],
                appendUserMessage: async () => undefined,
                streamAssistantTurn: async () => ({ text: "", sources: [], retrievalModeUsed: "keyword", rewriteResult: { originalQuery: "", rewrittenQuery: "", useRewrite: false } }),
                resetConversation: () => undefined,
            },
            knowledgeGraphService: graphService,
        } as unknown as VaultCoachApplicationDependencies);
        const events: string[] = [];
        application.subscribe((event) => events.push(event.type));

        const rebuilt = await application.graph.rebuild();
        rebuilt.nodes.pop();
        const snapshot = await application.graph.getSnapshot();
        const edge = (await application.graph.findEdgesForNode("markdown:notes/overview.md"))
            .find((candidate) => candidate.type === "links_to");
        const nodesByPath = await application.graph.findNodesByDocumentPath("notes/overview.md");
        const edgesBySource = await application.graph.findEdgesBySourceFile("notes/overview.md");
        if (!snapshot || !edge) throw new Error("Expected graph API facts.");
        edge.sources[0]?.chunkIds.push("mutated");

        expect(snapshot.nodes).toHaveLength(3);
        expect(await application.graph.getNode("markdown:notes/details.md")).toMatchObject({ type: "document" });
        expect(nodesByPath).toEqual([expect.objectContaining({ id: "markdown:notes/overview.md", type: "document" })]);
        expect(edgesBySource).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "links_to", sourceNodeId: "markdown:notes/overview.md" }),
        ]));
        expect((await application.graph.findEdgesForNode("markdown:notes/overview.md"))
            .find((candidate) => candidate.type === "links_to")?.sources[0]?.chunkIds).toEqual(["link-chunk"]);
        expect(await application.graph.checkIntegrity()).toEqual({ valid: true, issues: [] });
        expect(events).toEqual(["graph-state-changed"]);
    });

    it("invalidates cached Progress for index, effective graph, and Mastery source changes", async () => {
        const progressInvalidate = vi.fn();
        const store = new ApplicationGraphStore();
        const graphService = new KnowledgeGraphService(createApplicationGraphReader(), new DeterministicGraphBuilder(), store);
        const application = new VaultCoachApplication({
            chatService: {
                getMessages: () => [],
                appendUserMessage: async () => undefined,
                streamAssistantTurn: async () => ({ text: "", sources: [], retrievalModeUsed: "keyword", rewriteResult: { originalQuery: "", rewrittenQuery: "", useRewrite: false } }),
                resetConversation: () => undefined,
            },
            knowledgeGraphService: graphService,
            masteryService: {
                rebuildAll: vi.fn(async () => ({ states: [] })),
                clear: vi.fn(async () => undefined),
                markDirty: vi.fn(),
            } as unknown as MasteryService,
            progressService: {
                invalidate: progressInvalidate,
            } as unknown as ProgressService,
        } as unknown as VaultCoachApplicationDependencies);
        const events: string[] = [];
        application.subscribe((event) => events.push(event.type));

        application.notifyIndexStateChanged();
        await application.graph.rebuild();
        await application.mastery.rebuild();

        expect(progressInvalidate).toHaveBeenCalledTimes(3);
        expect(events).toEqual([
            "index-state-changed",
            "graph-state-changed",
            "mastery-state-changed",
            "mastery-state-changed",
        ]);
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

    it("keeps the saved exam and report when derived mastery synchronization fails", async () => {
        const masteryError = new Error("mastery cache unavailable");
        const harness = createExamSaveHarness({ masterySyncError: masteryError });
        const events: string[] = [];
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        harness.application.subscribe((event) => events.push(event.type));

        const saved = await harness.application.exam.saveSession(createScoredSession());

        expect(saved.status).toBe("saved");
        expect(harness.documents.get("session-1")?.assessmentEvents).toHaveLength(1);
        expect(harness.writeAssessmentProjection).toHaveBeenCalledOnce();
        expect(harness.syncMastery).toHaveBeenCalledOnce();
        expect(harness.markMasteryDirty).toHaveBeenCalledOnce();
        expect(events).toEqual(["mastery-state-changed", "exam-history-changed"]);
        errorSpy.mockRestore();
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

    it("invalidates cached Progress only when persisted Assessment facts change", async () => {
        const progressInvalidate = vi.fn();
        const harness = createExamSaveHarness({ progressInvalidate });
        const first = createScoredSession();

        await harness.application.exam.saveSession(first);
        await harness.application.exam.saveSession(first);
        await harness.application.exam.saveSession(createScoredSession({ score: 92, evaluatedAt: 200 }));

        expect(progressInvalidate).toHaveBeenCalledTimes(2);
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

    it("merges JSON and legacy history, rebuilds a missing report, and deletes only that report", async () => {
        const harness = createExamSaveHarness();
        await harness.application.exam.saveSession(createScoredSession());
        const structuredPath = ".vault-coach/assessments/sessions/session-1.json";
        harness.markdownHistoryRecords.push(
            {
                item: {
                    path: ".vault-coach/exams/session-1-结构化证据测试.md",
                    title: "重复的结构化报告",
                    createdAt: 1,
                    score: 80,
                    maxScore: 100,
                    modifiedAt: 1,
                },
                sessionId: "session-1",
            },
            {
                item: {
                    path: ".vault-coach/exams/legacy.md",
                    title: "旧 Markdown 记录",
                    createdAt: 2,
                    score: 60,
                    maxScore: 100,
                    modifiedAt: 2,
                },
                sessionId: null,
            },
        );

        const history = await harness.application.exam.listHistory();
        expect(history.map((item) => item.path)).toEqual([".vault-coach/exams/legacy.md", structuredPath]);

        await expect(harness.application.exam.readHistory(structuredPath)).resolves.toBe("重建的 Markdown 报告");
        expect(harness.readOrCreateAssessmentProjection).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "session-1" }),
            structuredPath,
        );

        await harness.application.exam.deleteHistory(structuredPath);
        expect(harness.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
        expect(harness.documents.has("session-1")).toBe(true);

        await expect(harness.application.exam.readHistory(".vault-coach/exams/legacy.md")).resolves.toBe("旧报告");
        await harness.application.exam.deleteHistory(".vault-coach/exams/legacy.md");
        expect(harness.deleteHistory).toHaveBeenCalledWith(".vault-coach/exams/legacy.md");
    });
});

interface ExamSaveHarnessOptions {
    saveFactsError?: Error;
    writeReportError?: Error;
    evaluate?: ReturnType<typeof vi.fn>;
    masterySyncError?: Error;
    progressInvalidate?: ReturnType<typeof vi.fn>;
}

function createExamSaveHarness(options: ExamSaveHarnessOptions = {}) {
    const documents = new Map<string, AssessmentSessionDocumentV1>();
    const callOrder: string[] = [];
    const markdownHistoryRecords: MarkdownExamHistoryRecord[] = [];
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
    const readOrCreateAssessmentProjection = vi.fn(async () => "重建的 Markdown 报告");
    const readHistoryContent = vi.fn(async () => "旧报告");
    const deleteSession = vi.fn(async () => undefined);
    const deleteHistory = vi.fn(async () => undefined);
    const eventIds = ["event-1", "event-2", "event-3"];
    const syncMastery = vi.fn(async () => {
        if (options.masterySyncError) throw options.masterySyncError;
        return { updated: true, recalculatedConceptIds: ["concept:rag"] };
    });
    const markMasteryDirty = vi.fn(() => undefined);
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
            listMarkdownHistoryRecords: async () => markdownHistoryRecords,
            readOrCreateAssessmentProjection,
            readHistoryContent,
            deleteSession,
            deleteHistory,
        },
        assessmentSessionStore: {
            read: async (sessionId: string) => documents.get(sessionId) ?? null,
            save: saveAssessmentDocument,
            listHistory: async (): Promise<AssessmentExamHistoryItem[]> => Array.from(documents.values())
                .map((document: AssessmentSessionDocumentV1) => ({
                    path: `.vault-coach/assessments/sessions/${document.sessionId}.json`,
                    sessionId: document.sessionId,
                    sessionPath: `.vault-coach/assessments/sessions/${document.sessionId}.json`,
                    reportPath: document.examSession.savedPath,
                    title: document.examSession.title,
                    createdAt: document.examSession.createdAt,
                    score: document.examSession.evaluation?.score ?? null,
                    maxScore: document.examSession.evaluation?.maxScore ?? null,
                    modifiedAt: document.savedAt,
                })),
        },
        assessmentEventFactory: new AssessmentEventFactory({
            createEventId: () => eventIds.shift() ?? "unexpected-event-id",
        }),
        getAssessmentSavedAt: () => 1000,
        getAssessmentSessionPath: (sessionId: string) => `.vault-coach/assessments/sessions/${sessionId}.json`,
        getAssessmentSessionIdFromPath: (path: string) => {
            const match = /^\.vault-coach\/assessments\/sessions\/([a-zA-Z0-9_-]+)\.json$/.exec(path);
            return match?.[1] ?? null;
        },
        getExamEvaluationMetadata: () => ({
            modelProvider: "ollama",
            modelName: "evaluation-model",
            promptVersion: "evaluation/v2",
            evaluatedAt: 100,
        }),
        ...(options.masterySyncError ? {
            masteryService: {
                syncForSession: syncMastery,
                markDirty: markMasteryDirty,
            },
        } : {}),
        ...(options.progressInvalidate ? {
            progressService: {
                invalidate: options.progressInvalidate,
            },
        } : {}),
    } as unknown as VaultCoachApplicationDependencies);

    return {
        application,
        documents,
        callOrder,
        saveAssessmentDocument,
        writeAssessmentProjection,
        readOrCreateAssessmentProjection,
        readHistoryContent,
        deleteSession,
        deleteHistory,
        markdownHistoryRecords,
        syncMastery,
        markMasteryDirty,
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

class ApplicationGraphStore implements GraphStore {
    private snapshot: GraphSnapshotV1 | null = null;

    async load(): Promise<GraphSnapshotV1 | null> {
        return this.snapshot;
    }

    async save(snapshot: GraphSnapshotV1): Promise<void> {
        this.snapshot = snapshot;
    }

    async clear(): Promise<void> {
        this.snapshot = null;
    }
}

function createApplicationGraphReader(): GraphSourceReader {
    const documents: GraphSourceDocument[] = [{
        documentId: "markdown:notes/details.md",
        filePath: "notes/details.md",
        documentType: "markdown",
        title: "details",
        contentHash: "details-hash",
        modifiedAt: 1,
        sections: [],
        links: [],
        embeds: [],
        tags: [],
    }, {
        documentId: "markdown:notes/overview.md",
        filePath: "notes/overview.md",
        documentType: "markdown",
        title: "overview",
        contentHash: "overview-hash",
        modifiedAt: 2,
        sections: [],
        links: [{ targetFilePath: "notes/details.md", chunkIds: ["link-chunk"] }],
        embeds: [],
        tags: [{ rawName: "#tag", chunkIds: [] }],
    }];
    return {
        readAll: () => ({ documents, diagnostics: [] }),
        readPaths: (filePaths) => ({
            documents: documents.filter((document) => filePaths.includes(document.filePath)),
            diagnostics: [],
        }),
    };
}
