import type { ExamEvaluation, ExamEvaluationItem, ExamEvaluationMetadata, ExamSession } from "./exam-types";
import { getQuestionAnswerForm } from "./exam-question-policy";
import { ExamEvaluationService } from "./exam-evaluation-service";
import { ObjectiveExamEvaluationService } from "./objective-exam-evaluation-service";

/** 应用层使用的统一评估端口。 */
export interface ExamEvaluator {
    evaluate(session: ExamSession, userAnswers: readonly string[], evaluator: ExamEvaluationMetadata): Promise<ExamEvaluation>;
}

/**
 * 所有旧版或仅自由回答的会话继续使用现有模型评估器。
 * 新客观题在本地评估后，必须归一化为 Assessment 当前消费的同一 `ExamEvaluation` 契约。
 */
export class ExamEvaluationRouter implements ExamEvaluator {
    constructor(
        private readonly freeResponseEvaluator: ExamEvaluationService,
        private readonly objectiveEvaluator: ObjectiveExamEvaluationService,
    ) {}

    async evaluate(
        session: ExamSession,
        userAnswers: readonly string[],
        evaluator: ExamEvaluationMetadata,
    ): Promise<ExamEvaluation> {
        const objectiveIndexes: number[] = [];
        const freeResponseIndexes: number[] = [];
        session.questions.forEach((question, index) => {
            if (getQuestionAnswerForm(question) === "free-response") freeResponseIndexes.push(index);
            else objectiveIndexes.push(index);
        });

        // 该精确分支用于保护全部既有自由回答会话行为，修改时必须先覆盖旧会话回归测试。
        if (objectiveIndexes.length === 0) {
            return this.freeResponseEvaluator.evaluate(session, userAnswers, evaluator);
        }
        if (freeResponseIndexes.length === 0) {
            return this.objectiveEvaluator.evaluate(session, userAnswers, evaluator.evaluatedAt);
        }

        const objectiveItems: ExamEvaluationItem[] = objectiveIndexes.map((index) => {
            const question = session.questions[index];
            if (!question) throw new Error(`题目索引无效：${index}`);
            return this.objectiveEvaluator.evaluateQuestion(question, userAnswers[index] ?? "", evaluator.evaluatedAt);
        });
        const freeResponseSession: ExamSession = {
            ...session,
            questions: freeResponseIndexes.map((index) => session.questions[index]).filter((question): question is NonNullable<typeof question> => question !== undefined),
            userAnswers: freeResponseIndexes.map((index) => userAnswers[index] ?? ""),
        };
        const freeResponseEvaluation = await this.freeResponseEvaluator.evaluate(
            freeResponseSession,
            freeResponseSession.userAnswers,
            evaluator,
        );
        const itemsById = new Map<string, ExamEvaluationItem>([
            ...objectiveItems,
            ...freeResponseEvaluation.items,
        ].map((item) => [item.questionId, item]));
        const items = session.questions.map((question) => {
            const item = itemsById.get(question.id);
            if (!item) throw new Error(`评分结果缺少题目 ${question.id}`);
            return item;
        });
        return this.combine(items);
    }

    private combine(items: readonly ExamEvaluationItem[]): ExamEvaluation {
        const score = items.length === 0 ? 0 : Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length);
        return {
            score,
            maxScore: 100,
            overallFeedback: "评分完成。请结合每题反馈复习未掌握的知识点。",
            items: [...items],
        };
    }
}
