import { describe, expect, it, vi } from "vitest";
import { ExamEvaluationRouter } from "../../../src/domain/exam/exam-evaluation-router";
import { ObjectiveExamEvaluationService } from "../../../src/domain/exam/objective-exam-evaluation-service";
import type { ExamEvaluation, ExamSession } from "../../../src/domain/exam/exam-types";
import type { ExamEvaluationService } from "../../../src/domain/exam/exam-evaluation-service";

const evaluator = {
    modelProvider: "ollama",
    modelName: "test-model",
    promptVersion: "test/v1",
    evaluatedAt: 100,
};

function objectiveSession(): ExamSession {
    return {
        id: "simple-1",
        title: "简单测试",
        createdAt: 1,
        scopeLabel: "知识库",
        selectedFolderPaths: [],
        excludedFilePaths: [],
        forceIncludedFilePaths: [],
        examMode: "simple",
        questions: [{
            id: "q1",
            blueprintItemId: "bp1",
            question: "哪项正确？",
            referenceAnswer: "答案 B",
            rubric: "本题按 100 分制评分；选择正确得 100 分。",
            questionType: "explanation",
            difficulty: "basic",
            answerForm: "single-choice",
            options: [{ id: "option-a", text: "A" }, { id: "option-b", text: "B" }, { id: "option-c", text: "C" }],
            correctOptionId: "option-b",
            sourceChunkIds: ["chunk-1"],
            evidenceExcerptIds: [],
            sourcePaths: ["notes/test.md"],
            conceptIds: ["concept:test"],
            generationMetadata: { modelProvider: "ollama", modelName: "test", promptVersion: "test/v1", generatedAt: 1 },
        }],
        userAnswers: [],
        evaluation: null,
        savedPath: null,
        status: "draft",
    };
}

describe("ExamEvaluationRouter", () => {
    it("scores simple objective answers locally without invoking the model evaluator", async () => {
        const freeEvaluate = vi.fn();
        const freeResponseEvaluator = { evaluate: freeEvaluate } as unknown as ExamEvaluationService;
        const router = new ExamEvaluationRouter(freeResponseEvaluator, new ObjectiveExamEvaluationService());

        const evaluation = await router.evaluate(objectiveSession(), ["option-b"], evaluator);

        expect(evaluation).toMatchObject({ score: 100, maxScore: 100 });
        expect(evaluation.items[0]).toMatchObject({
            score: 100,
            maxScore: 100,
            evaluationConfidence: 1,
            evaluator: { evaluatorKind: "deterministic", modelProvider: "deterministic" },
        });
        expect(freeEvaluate).not.toHaveBeenCalled();
    });

    it("keeps a legacy free-response-only session on the existing evaluator path", async () => {
        const legacy = objectiveSession();
        legacy.examMode = undefined;
        legacy.questions[0] = {
            ...legacy.questions[0]!,
            answerForm: undefined,
            options: undefined,
            correctOptionId: undefined,
        };
        const expected: ExamEvaluation = {
            score: 73,
            maxScore: 100,
            overallFeedback: "模型评分",
            items: [],
        };
        const freeEvaluate = vi.fn(async () => expected);
        const freeResponseEvaluator = { evaluate: freeEvaluate } as unknown as ExamEvaluationService;
        const router = new ExamEvaluationRouter(freeResponseEvaluator, new ObjectiveExamEvaluationService());

        await expect(router.evaluate(legacy, ["自由文本"], evaluator)).resolves.toBe(expected);
        expect(freeEvaluate).toHaveBeenCalledWith(legacy, ["自由文本"], evaluator);
    });
});
