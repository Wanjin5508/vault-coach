import { describe, expect, it } from "vitest";
import {
    createAssessmentEvaluationFingerprint,
    getQuestionIdsNeedingAssessmentEvents,
} from "../../../src/domain/assessment/assessment-event-fingerprint";
import type { AssessmentEvent } from "../../../src/domain/assessment/assessment-types";
import type { ExamSession } from "../../../src/domain/exam/exam-types";

function createSession(evaluatedAt = 100): ExamSession {
    return {
        id: "fingerprint-session",
        title: "评分指纹测试",
        createdAt: 1,
        scopeLabel: "完整知识库",
        selectedFolderPaths: [],
        excludedFilePaths: [],
        forceIncludedFilePaths: [],
        questions: [{
            id: "q1",
            blueprintItemId: "bp1",
            question: "什么是 RAG？",
            referenceAnswer: "检索增强生成。",
            rubric: "100 分制。",
            questionType: "explanation",
            difficulty: "basic",
            sourceChunkIds: ["chunk-1"],
            evidenceExcerptIds: ["E1"],
            sourcePaths: ["notes/rag.md"],
            conceptIds: ["exam-topic:rag"],
            generationMetadata: {
                modelProvider: "ollama",
                modelName: "test-model",
                promptVersion: "question/v1",
                generatedAt: 1,
            },
        }],
        userAnswers: ["检索增强生成"],
        evaluation: {
            score: 80,
            maxScore: 100,
            overallFeedback: "完成。",
            items: [{
                questionId: "q1",
                score: 80,
                maxScore: 100,
                feedback: "正确。",
                improvement: "补充例子。",
                coveredKeyPoints: ["检索"],
                missingKeyPoints: [],
                errorCodes: ["missing-key-point", "other"],
                evaluationConfidence: 0.8,
                evaluator: {
                    modelProvider: "ollama",
                    modelName: "evaluation-model",
                    promptVersion: "evaluation/v2",
                    evaluatedAt,
                },
            }],
        },
        savedPath: null,
        status: "submitted",
    };
}

function createPersistedEvent(): AssessmentEvent {
    return {
        id: "event-1",
        eventType: "exam-answer",
        sessionId: "fingerprint-session",
        questionId: "q1",
        conceptIds: ["exam-topic:rag"],
        sourceChunkIds: ["chunk-1"],
        rawScore: 80,
        normalizedScore: 0.8,
        difficulty: "basic",
        questionType: "explanation",
        errorCodes: ["other", "missing-key-point"],
        evidenceConfidence: 1,
        evaluationConfidence: 0.8,
        occurredAt: 100,
        evaluator: {
            provider: "ollama",
            model: "evaluation-model",
            promptVersion: "evaluation/v2",
        },
    };
}

describe("assessment event fingerprints", () => {
    it("treats reordered error codes as the same evaluation result", () => {
        const session = createSession();
        const evaluation = session.evaluation?.items[0];
        if (!evaluation) {
            throw new Error("测试需要评分项。");
        }

        expect(getQuestionIdsNeedingAssessmentEvents(session, [createPersistedEvent()])).toEqual([]);
        expect(createAssessmentEvaluationFingerprint(session.id, evaluation)).toContain('"evaluatedAt":100');
    });

    it("requires a replacement event when evaluator time or prompt version changes", () => {
        const reEvaluated = createSession(101);
        reEvaluated.evaluation!.items[0]!.evaluator.promptVersion = "evaluation/v3";

        expect(getQuestionIdsNeedingAssessmentEvents(reEvaluated, [createPersistedEvent()])).toEqual(["q1"]);
    });
});
