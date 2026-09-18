import type { ExamEvaluationItem, ExamQuestion, ExamSession } from "../exam/exam-types";
import type {
    AssessmentConceptBinding,
    AssessmentEvent,
    AssessmentEventCreationResult,
} from "./assessment-types";

export interface AssessmentEventFactoryDependencies {
    createEventId(): string;
}

/**
 * Converts a scored exam session into immutable assessment evidence.
 *
 * The factory intentionally has no clock, model, storage, or Obsidian dependency:
 * evaluation time and provenance are already part of the evaluated session, while
 * callers explicitly inject deterministic event IDs.
 */
export class AssessmentEventFactory {
    constructor(private readonly dependencies: AssessmentEventFactoryDependencies) {}

    createForExamSession(
        session: ExamSession,
        previousEvents: readonly AssessmentEvent[] = [],
    ): AssessmentEventCreationResult {
        return this.createForQuestionIds(
            session,
            session.questions.map((question: ExamQuestion) => question.id),
            previousEvents,
        );
    }

    /** Creates evidence for a selected subset of questions in an evaluated session. */
    createForQuestionIds(
        session: ExamSession,
        questionIds: readonly string[],
        previousEvents: readonly AssessmentEvent[] = [],
    ): AssessmentEventCreationResult {
        const conceptBindings = this.createConceptBindings(session);
        if (!session.evaluation) {
            return { events: [], conceptBindings };
        }

        const evaluationByQuestionId: Map<string, ExamEvaluationItem> = new Map<string, ExamEvaluationItem>(
            session.evaluation.items.map((item: ExamEvaluationItem) => [item.questionId, item]),
        );
        const requestedQuestionIds = new Set<string>(questionIds);
        const events: AssessmentEvent[] = session.questions
            .filter((question: ExamQuestion) => requestedQuestionIds.has(question.id))
            .map((question: ExamQuestion) => {
            const evaluation: ExamEvaluationItem | undefined = evaluationByQuestionId.get(question.id);
            if (!evaluation) {
                throw new Error(`已评分考试缺少题目 ${question.id} 的评分项。`);
            }

            return this.createEvent(session, question, evaluation, previousEvents);
            });

        return { events, conceptBindings };
    }

    private createEvent(
        session: ExamSession,
        question: ExamQuestion,
        evaluation: ExamEvaluationItem,
        previousEvents: readonly AssessmentEvent[],
    ): AssessmentEvent {
        const supersedesEventId: string | undefined = this.findActiveEventId(
            previousEvents,
            session.id,
            question.id,
        );
        const event: AssessmentEvent = {
            id: this.dependencies.createEventId(),
            eventType: "exam-answer",
            sessionId: session.id,
            questionId: question.id,
            conceptIds: [...question.conceptIds],
            sourceChunkIds: [...question.sourceChunkIds],
            rawScore: evaluation.score,
            normalizedScore: this.normalizeScore(evaluation.score, evaluation.maxScore),
            difficulty: question.difficulty,
            questionType: question.questionType,
            errorCodes: Array.from(new Set(evaluation.errorCodes)),
            evidenceConfidence: this.calculateEvidenceConfidence(question),
            evaluationConfidence: this.clampProbability(evaluation.evaluationConfidence),
            occurredAt: evaluation.evaluator.evaluatedAt,
            evaluator: {
                provider: evaluation.evaluator.modelProvider,
                model: evaluation.evaluator.modelName,
                promptVersion: evaluation.evaluator.promptVersion,
                ...(evaluation.evaluator.evaluatorKind ? { kind: evaluation.evaluator.evaluatorKind } : {}),
            },
            ...this.createAdaptiveAudit(session, question),
        };

        return supersedesEventId ? { ...event, supersedesEventId } : event;
    }

    private createAdaptiveAudit(session: ExamSession, question: ExamQuestion): Pick<AssessmentEvent, "adaptive"> {
        const plan = session.adaptivePlan;
        if (!plan || !question.plannedTargetConceptIds) return {};
        const plannedTargetConceptIds = question.plannedTargetConceptIds
            .filter((conceptId) => question.conceptIds.includes(conceptId) && plan.targetConceptIds.includes(conceptId))
            .sort((left, right) => left.localeCompare(right));
        return plannedTargetConceptIds.length > 0 ? {
            adaptive: {
                planId: plan.planId,
                targetMode: plan.targetMode,
                plannedTargetConceptIds,
            },
        } : {};
    }

    private createConceptBindings(session: ExamSession): AssessmentConceptBinding[] {
        const blueprintItemsById = new Map(
            (session.blueprint?.items ?? []).map((item) => [item.id, item]),
        );
        const bindingsById = new Map<string, AssessmentConceptBinding>();

        for (const question of session.questions) {
            const blueprintItem = blueprintItemsById.get(question.blueprintItemId);
            const label = blueprintItem?.topic.trim() || question.blueprintItemId;
            for (const conceptId of question.conceptIds) {
                if (!bindingsById.has(conceptId)) {
                    bindingsById.set(conceptId, {
                        id: conceptId,
                        label,
                        sourceBlueprintItemId: question.blueprintItemId,
                        kind: "provisional-topic",
                    });
                }
            }
        }

        return Array.from(bindingsById.values());
    }

    private findActiveEventId(
        previousEvents: readonly AssessmentEvent[],
        sessionId: string,
        questionId: string,
    ): string | undefined {
        const supersededEventIds = new Set<string>(
            previousEvents.flatMap((event: AssessmentEvent) => event.supersedesEventId ? [event.supersedesEventId] : []),
        );
        const activeEvents = previousEvents
            .filter((event: AssessmentEvent) => {
                return event.sessionId === sessionId
                    && event.questionId === questionId
                    && !supersededEventIds.has(event.id);
            })
            .sort((left: AssessmentEvent, right: AssessmentEvent) => {
                return right.occurredAt - left.occurredAt || right.id.localeCompare(left.id);
            });

        return activeEvents[0]?.id;
    }

    private normalizeScore(score: number, maxScore: number): number {
        if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
            return 0;
        }

        return this.clampProbability(score / maxScore);
    }

    private calculateEvidenceConfidence(question: ExamQuestion): number {
        if (question.sourceChunkIds.length === 0) {
            return 0;
        }

        return question.evidenceExcerptIds.length > 0 ? 1 : 0.7;
    }

    private clampProbability(value: number): number {
        if (!Number.isFinite(value)) {
            return 0;
        }

        return Math.max(0, Math.min(1, value));
    }
}
