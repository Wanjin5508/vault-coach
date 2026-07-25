import { describe, expect, it } from "vitest";
import { AssessmentEventFactory } from "../../../src/domain/assessment/assessment-event-factory";
import type { AssessmentEvent } from "../../../src/domain/assessment/assessment-types";
import type { ExamSession } from "../../../src/domain/exam/exam-types";

function createScoredSession(): ExamSession {
    return {
        id: "session-1",
        title: "结构化证据测试",
        createdAt: 1,
        scopeLabel: "完整知识库",
        selectedFolderPaths: [],
        excludedFilePaths: [],
        forceIncludedFilePaths: [],
        blueprint: {
            title: "结构化证据测试",
            requestedQuestionCount: 2,
            plannedQuestionCount: 2,
            items: [
                {
                    id: "bp-retrieval",
                    topic: "检索增强生成",
                    learningObjective: "理解检索与生成如何结合",
                    questionType: "explanation",
                    difficulty: "basic",
                    sourceChunkIds: ["chunk-rag"],
                },
                {
                    id: "bp-application",
                    topic: "RAG 应用流程",
                    learningObjective: "能够说明应用步骤",
                    questionType: "application",
                    difficulty: "advanced",
                    sourceChunkIds: [],
                },
            ],
        },
        questions: [
            {
                id: "q1",
                blueprintItemId: "bp-retrieval",
                question: "什么是 RAG？",
                referenceAnswer: "检索增强生成。",
                rubric: "100 分制。",
                questionType: "explanation",
                difficulty: "basic",
                sourceChunkIds: ["chunk-rag"],
                evidenceExcerptIds: ["E1"],
                sourcePaths: ["notes/rag.md"],
                conceptIds: ["exam-topic:retrieval"],
                generationMetadata: {
                    modelProvider: "ollama",
                    modelName: "question-model",
                    promptVersion: "question/v1",
                    generatedAt: 10,
                },
            },
            {
                id: "q2",
                blueprintItemId: "bp-application",
                question: "如何应用 RAG？",
                referenceAnswer: "先检索再生成。",
                rubric: "100 分制。",
                questionType: "application",
                difficulty: "advanced",
                sourceChunkIds: [],
                evidenceExcerptIds: [],
                sourcePaths: [],
                conceptIds: ["exam-topic:application"],
                generationMetadata: {
                    modelProvider: "ollama",
                    modelName: "question-model",
                    promptVersion: "question/v1",
                    generatedAt: 10,
                },
            },
        ],
        userAnswers: ["检索增强生成", "先检索再生成"],
        evaluation: {
            score: 43,
            maxScore: 100,
            overallFeedback: "完成。",
            items: [
                {
                    questionId: "q1",
                    score: 75,
                    maxScore: 100,
                    feedback: "覆盖核心概念。",
                    improvement: "补充示例。",
                    coveredKeyPoints: ["检索", "生成"],
                    missingKeyPoints: ["上下文"],
                    errorCodes: ["missing-key-point"],
                    evaluationConfidence: 0.8,
                    evaluator: {
                        modelProvider: "ollama",
                        modelName: "evaluation-model",
                        promptVersion: "evaluation/v2",
                        evaluatedAt: 100,
                    },
                },
                {
                    questionId: "q2",
                    score: 10,
                    maxScore: 100,
                    feedback: "步骤不完整。",
                    improvement: "补足步骤。",
                    coveredKeyPoints: [],
                    missingKeyPoints: ["检索", "生成"],
                    errorCodes: ["incomplete-process", "incomplete-process"],
                    evaluationConfidence: 1.2,
                    evaluator: {
                        modelProvider: "ollama",
                        modelName: "evaluation-model",
                        promptVersion: "evaluation/v2",
                        evaluatedAt: 101,
                    },
                },
            ],
        },
        savedPath: null,
        status: "submitted",
    };
}

function createFactory(...eventIds: string[]): AssessmentEventFactory {
    return new AssessmentEventFactory({
        createEventId: () => {
            const eventId = eventIds.shift();
            if (!eventId) {
                throw new Error("测试未提供 event ID。");
            }
            return eventId;
        },
    });
}

describe("AssessmentEventFactory", () => {
    it("maps every evaluated question to immutable, traceable assessment evidence", () => {
        const session = createScoredSession();
        const result = createFactory("event-1", "event-2").createForExamSession(session);

        expect(result.events).toEqual([
            {
                id: "event-1",
                eventType: "exam-answer",
                sessionId: "session-1",
                questionId: "q1",
                conceptIds: ["exam-topic:retrieval"],
                sourceChunkIds: ["chunk-rag"],
                rawScore: 75,
                normalizedScore: 0.75,
                difficulty: "basic",
                questionType: "explanation",
                errorCodes: ["missing-key-point"],
                evidenceConfidence: 1,
                evaluationConfidence: 0.8,
                occurredAt: 100,
                evaluator: {
                    provider: "ollama",
                    model: "evaluation-model",
                    promptVersion: "evaluation/v2",
                },
            },
            {
                id: "event-2",
                eventType: "exam-answer",
                sessionId: "session-1",
                questionId: "q2",
                conceptIds: ["exam-topic:application"],
                sourceChunkIds: [],
                rawScore: 10,
                normalizedScore: 0.1,
                difficulty: "advanced",
                questionType: "application",
                errorCodes: ["incomplete-process"],
                evidenceConfidence: 0,
                evaluationConfidence: 1,
                occurredAt: 101,
                evaluator: {
                    provider: "ollama",
                    model: "evaluation-model",
                    promptVersion: "evaluation/v2",
                },
            },
        ]);
        expect(result.conceptBindings).toEqual([
            {
                id: "exam-topic:retrieval",
                label: "检索增强生成",
                sourceBlueprintItemId: "bp-retrieval",
                kind: "provisional-topic",
            },
            {
                id: "exam-topic:application",
                label: "RAG 应用流程",
                sourceBlueprintItemId: "bp-application",
                kind: "provisional-topic",
            },
        ]);

        const firstEvent = result.events[0];
        if (!firstEvent) {
            throw new Error("测试预期存在第一条 Assessment Event。");
        }
        firstEvent.sourceChunkIds.push("mutated");
        firstEvent.evaluator.model = "mutated";
        expect(session.questions[0]?.sourceChunkIds).toEqual(["chunk-rag"]);
        expect(session.evaluation?.items[0]?.evaluator.modelName).toBe("evaluation-model");
    });

    it("creates no assessment event for a draft session", () => {
        const session = createScoredSession();
        session.evaluation = null;

        const result = createFactory().createForExamSession(session);

        expect(result.events).toEqual([]);
        expect(result.conceptBindings).toHaveLength(2);
    });

    it("keeps adaptive audit data separate from evidence-bound Mastery inputs", () => {
        const session = createScoredSession();
        session.examMode = "simple";
        session.adaptivePlan = {
            planId: "adaptive-exam:1",
            algorithmVersion: "adaptive-exam/v1",
            inputFingerprint: "fingerprint",
            targetMode: "diagnostic",
            examMode: "simple",
            scopeSignature: "scope",
            targetConceptIds: ["exam-topic:retrieval"],
            reasonCodesByConceptId: { "exam-topic:retrieval": ["unassessed"] },
            appliedFallbacks: [],
        };
        const firstQuestion = session.questions[0];
        const firstEvaluation = session.evaluation?.items[0];
        if (!firstQuestion || !firstEvaluation) throw new Error("Expected first question and evaluation.");
        firstQuestion.plannedTargetConceptIds = ["exam-topic:retrieval", "not-evidenced"];
        firstEvaluation.evaluator.evaluatorKind = "deterministic";

        const event = createFactory("event-adaptive").createForQuestionIds(session, ["q1"]).events[0];

        expect(event).toMatchObject({
            conceptIds: ["exam-topic:retrieval"],
            evaluator: { kind: "deterministic" },
            adaptive: {
                planId: "adaptive-exam:1",
                targetMode: "diagnostic",
                plannedTargetConceptIds: ["exam-topic:retrieval"],
            },
        });
    });

    it("links a re-evaluation to the latest active event without modifying history", () => {
        const session = createScoredSession();
        const oldEvent: AssessmentEvent = {
            id: "event-old",
            eventType: "exam-answer",
            sessionId: "session-1",
            questionId: "q1",
            conceptIds: ["exam-topic:retrieval"],
            sourceChunkIds: ["chunk-rag"],
            rawScore: 50,
            normalizedScore: 0.5,
            difficulty: "basic",
            questionType: "explanation",
            errorCodes: ["missing-key-point"],
            evidenceConfidence: 1,
            evaluationConfidence: 0.5,
            occurredAt: 20,
            evaluator: { provider: "ollama", model: "old-model", promptVersion: "evaluation/v1" },
        };
        const currentEvent: AssessmentEvent = {
            ...oldEvent,
            id: "event-current",
            occurredAt: 30,
            supersedesEventId: "event-old",
        };

        const result = createFactory("event-next-q1", "event-next-q2").createForExamSession(session, [oldEvent, currentEvent]);

        expect(result.events[0]?.supersedesEventId).toBe("event-current");
        expect(result.events[1]?.supersedesEventId).toBeUndefined();
        expect(oldEvent).not.toHaveProperty("supersedesEventId");
        expect(currentEvent.supersedesEventId).toBe("event-old");
    });

    it("rejects an incomplete evaluation before it can become partial evidence", () => {
        const session = createScoredSession();
        session.evaluation?.items.pop();

        expect(() => createFactory("unused").createForExamSession(session)).toThrow("已评分考试缺少题目 q2 的评分项。");
    });
});
