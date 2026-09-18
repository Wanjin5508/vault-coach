import type {
    AssessmentErrorCode,
    ExamEvaluation,
    ExamEvaluationItem,
    ExamEvaluationMetadata,
    ExamQuestion,
    ExamSession,
} from "./exam-types";
import { isObjectiveQuestion } from "./exam-question-policy";

/**
 * Scores only questions with an explicit answer key. It deliberately performs
 * no model request, so simple-mode results remain reproducible and auditable.
 */
export class ObjectiveExamEvaluationService {
    evaluate(
        session: ExamSession,
        userAnswers: readonly string[],
        evaluatedAt: number,
    ): ExamEvaluation {
        const items: ExamEvaluationItem[] = session.questions.map((question, index) => {
            if (!isObjectiveQuestion(question)) {
                throw new Error(`客观题评分器不能评分自由文本题：${question.id}`);
            }
            return this.evaluateQuestion(question, userAnswers[index] ?? "", evaluatedAt);
        });
        return this.combine(items);
    }

    evaluateQuestion(question: ExamQuestion, rawAnswer: string, evaluatedAt: number): ExamEvaluationItem {
        if (!isObjectiveQuestion(question)) {
            throw new Error(`题目 ${question.id} 没有合法的客观题答案键。`);
        }
        const answer = rawAnswer.trim();
        const answered = answer.length > 0;
        const correct = answered && answer === question.correctOptionId;
        const correctOption = question.options.find((option) => option.id === question.correctOptionId);
        const evaluator: ExamEvaluationMetadata = {
            modelProvider: "deterministic",
            modelName: "objective-answer-key",
            promptVersion: "exam-objective-evaluation/v1",
            evaluatedAt,
            evaluatorKind: "deterministic",
        };
        const errorCodes: AssessmentErrorCode[] = correct
            ? []
            : [answered ? "incorrect-definition" : "no-answer"];
        return {
            questionId: question.id,
            score: correct ? 100 : 0,
            maxScore: 100,
            feedback: correct
                ? "回答正确。"
                : `回答不正确。正确答案是：${correctOption?.text ?? question.referenceAnswer}`,
            improvement: correct
                ? "已正确掌握本题考察的知识点。"
                : "请对照参考答案和来源内容复习后再尝试。",
            coveredKeyPoints: correct ? [question.referenceAnswer] : [],
            missingKeyPoints: correct ? [] : [question.referenceAnswer],
            errorCodes,
            evaluationConfidence: 1,
            evaluator,
        };
    }

    combine(items: readonly ExamEvaluationItem[]): ExamEvaluation {
        const score = items.length === 0 ? 0 : Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length);
        return {
            score,
            maxScore: 100,
            overallFeedback: score === 100
                ? "全部客观题回答正确。"
                : "评分完成。请结合每题反馈复习未掌握的知识点。",
            items: [...items],
        };
    }
}
