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
            { id: "q1", question: "问题一", referenceAnswer: "答案一", rubric: "100 分制", sourcePaths: [] },
            { id: "q2", question: "问题二", referenceAnswer: "答案二", rubric: "100 分制", sourcePaths: [] },
        ],
        userAnswers: [],
        evaluation: null,
        savedPath: null,
        status: "draft",
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
});
