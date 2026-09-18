import type { ExamEvaluation, ExamEvaluationItem, ExamEvaluationMetadata, ExamSession } from "./exam-types";
import { getQuestionAnswerForm } from "./exam-question-policy";
import { ExamEvaluationService } from "./exam-evaluation-service";
import { ObjectiveExamEvaluationService } from "./objective-exam-evaluation-service";

/** Common evaluation port used by the application layer. */
export interface ExamEvaluator {
    evaluate(session: ExamSession, userAnswers: readonly string[], evaluator: ExamEvaluationMetadata): Promise<ExamEvaluation>;
}

/**
 * Preserves the existing model evaluator for every legacy/free-response-only
 * session. New objective questions are evaluated locally, then normalized back
 * into the exact same ExamEvaluation contract consumed by Assessment.
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

        // This exact path protects all existing free-response session behavior.
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
