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
 * Produces the stable identity of one evaluation result. It intentionally uses
 * evaluator time and prompt version so a genuine re-evaluation produces a new
 * immutable event while a repeated save of the same result remains idempotent.
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

/** Creates the equivalent fingerprint from already-persisted assessment facts. */
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
 * Returns only questions whose evaluated result has not yet been persisted.
 * Incomplete evaluation data is deliberately left for AssessmentEventFactory
 * to reject before any persistence occurs.
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
