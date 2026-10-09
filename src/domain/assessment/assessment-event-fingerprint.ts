import type { AssessmentEvent } from "./assessment-types";
import type { ExamEvaluationItem, ExamSession } from "../exam/exam-types";

interface AssessmentEventFingerprintFields {
    sessionId: string;
    questionId: string;
    score: number;
    errorCodes: string[];
    evaluator: {
        provider: string;
        model: string;
        promptVersion: string;
        evaluatedAt: number;
    };
}

/**
 * 生成单次评估结果的稳定标识。
 *
 * 指纹包含评估时间和提示词版本，使真实的重新评估产生新的不可变事件，
 * 同一结果的重复保存则保持幂等。
 */
export function createAssessmentEvaluationFingerprint(
    sessionId: string,
    evaluation: ExamEvaluationItem,
): string {
    return serializeFingerprint({
        sessionId,
        questionId: evaluation.questionId,
        score: evaluation.score,
        errorCodes: evaluation.errorCodes,
        evaluator: {
            provider: evaluation.evaluator.modelProvider,
            model: evaluation.evaluator.modelName,
            promptVersion: evaluation.evaluator.promptVersion,
            evaluatedAt: evaluation.evaluator.evaluatedAt,
        },
    });
}

/** 根据已持久化的 Assessment 事实生成等价指纹。 */
export function createAssessmentEventFingerprint(event: AssessmentEvent): string {
    return serializeFingerprint({
        sessionId: event.sessionId,
        questionId: event.questionId,
        score: event.rawScore,
        errorCodes: event.errorCodes,
        evaluator: {
            provider: event.evaluator.provider,
            model: event.evaluator.model,
            promptVersion: event.evaluator.promptVersion,
            evaluatedAt: event.occurredAt,
        },
    });
}

/**
 * 仅返回评估结果尚未持久化的问题。
 *
 * 不完整评估数据继续交由 `AssessmentEventFactory` 在任何持久化发生前拒绝。
 */
export function getQuestionIdsNeedingAssessmentEvents(
    session: ExamSession,
    existingEvents: readonly AssessmentEvent[],
): string[] {
    if (!session.evaluation) {
        return [];
    }

    const persistedFingerprints = new Set<string>(
        existingEvents.map((event: AssessmentEvent) => createAssessmentEventFingerprint(event)),
    );
    const evaluationsByQuestionId = new Map<string, ExamEvaluationItem>(
        session.evaluation.items.map((item: ExamEvaluationItem) => [item.questionId, item]),
    );

    return session.questions
        .filter((question) => {
            const evaluation = evaluationsByQuestionId.get(question.id);
            return !evaluation
                || !persistedFingerprints.has(createAssessmentEvaluationFingerprint(session.id, evaluation));
        })
        .map((question) => question.id);
}

function serializeFingerprint(fields: AssessmentEventFingerprintFields): string {
    return JSON.stringify({
        sessionId: fields.sessionId,
        questionId: fields.questionId,
        score: fields.score,
        errorCodes: Array.from(new Set(fields.errorCodes)).sort((left: string, right: string) => left.localeCompare(right)),
        evaluator: fields.evaluator,
    });
}
