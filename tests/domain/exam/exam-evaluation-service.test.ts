import { describe, expect, it, vi } from "vitest";
import { ExamEvaluationService } from "../../../src/domain/exam/exam-evaluation-service";
import type { ExamSession } from "../../../src/domain/exam/exam-types";
import type { JsonGenerationGateway } from "../../../src/domain/model/json-generation-gateway";

function createSession(): ExamSession {
    return {
        id: "exam_test",
        title: "评分测试",
        createdAt: 1,
        scopeLabel: "知识库",
        selectedFolderPaths: [],
        excludedFilePaths: [],
        forceIncludedFilePaths: [],
        questions: [
            createQuestion("q1"),
            createQuestion("q2"),
        ],
        userAnswers: [],
        evaluation: null,
        savedPath: null,
        status: "draft",
    };
}

function createQuestion(id: string) {
    return {
        id,
        blueprintItemId: `bp-${id}`,
        question: `问题${id}`,
        referenceAnswer: `答案${id}`,
        rubric: "100 分制",
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
    };
}

function gateway(...responses: string[]): JsonGenerationGateway {
    return {
        generateJsonAnswer: async () => responses.shift() ?? "{}",
    };
}

describe("ExamEvaluationService", () => {
    it("parses fenced JSON and aligns items by question id", async () => {
        const service = new ExamEvaluationService(gateway(`\`\`\`json
{"score":82,"overall_feedback":"总体良好","items":[{"question_id":"q2","score":70,"feedback":"反馈二","improvement":"建议二"},{"question_id":"q1","score":94,"feedback":"反馈一","improvement":"建议一"}]}
\`\`\``));

        await expect(service.evaluate(createSession(), ["回答一", "回答二"])).resolves.toEqual({
            score: 82,
            maxScore: 100,
            overallFeedback: "总体良好",
            items: [
                { questionId: "q1", score: 94, maxScore: 100, feedback: "反馈一", improvement: "建议一" },
                { questionId: "q2", score: 70, maxScore: 100, feedback: "反馈二", improvement: "建议二" },
            ],
        });
    });

    it("fills missing items and falls back to the average item score", async () => {
        const service = new ExamEvaluationService(gateway(JSON.stringify({
            items: [{ question_id: "q1", score: 80 }],
        })));

        const evaluation = await service.evaluate(createSession(), ["回答一"]);

        expect(evaluation.score).toBe(40);
        expect(evaluation.items[1]).toEqual({
            questionId: "q2",
            score: 0,
            maxScore: 100,
            feedback: "未提供本题反馈。",
            improvement: "请对照参考答案补全关键点。",
        });
    });

    it("clamps out-of-range scores and repairs malformed JSON once", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const service = new ExamEvaluationService(gateway(
            "{\"score\": 90,}",
            JSON.stringify({ score: 150, items: [{ score: -1 }, { score: 135 }] }),
        ));

        const evaluation = await service.evaluate(createSession(), []);

        expect(evaluation.score).toBe(100);
        expect(evaluation.items.map((item) => item.score)).toEqual([0, 100]);
        expect(warn).toHaveBeenCalledOnce();
    });

    it("keeps the existing 100-point contract when the model reports another maximum", async () => {
        const service = new ExamEvaluationService(gateway(JSON.stringify({
            score: 25,
            max_score: 40,
            overall_feedback: "按模型最大分数计算。",
            items: [
                { question_id: "q1", score: 25, max_score: 40, feedback: "反馈一", improvement: "建议一" },
                { question_id: "q2", score: 40, max_score: 40, feedback: "反馈二", improvement: "建议二" },
            ],
        })));

        await expect(service.evaluate(createSession(), ["回答一", "回答二"])).resolves.toEqual({
            score: 25,
            maxScore: 100,
            overallFeedback: "按模型最大分数计算。",
            items: [
                { questionId: "q1", score: 25, maxScore: 100, feedback: "反馈一", improvement: "建议一" },
                { questionId: "q2", score: 40, maxScore: 100, feedback: "反馈二", improvement: "建议二" },
            ],
        });
    });
});
