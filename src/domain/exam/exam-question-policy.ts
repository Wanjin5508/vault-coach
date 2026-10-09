/**
 * 考试题型策略和规范化规则。
 *
 * 简单模式仅接受可确定评分的客观题；选项按 ID 和规范化文本去重，以保持评分输入稳定。
 */
import type { ExamAnswerForm, ExamChoiceOption, ExamMode, ExamQuestion } from "./exam-types";

export type ObjectiveExamQuestion = ExamQuestion & {
    answerForm: "single-choice" | "true-false";
    options: ExamChoiceOption[];
    correctOptionId: string;
};

export const SIMPLE_EXAM_ANSWER_FORMS: readonly ExamAnswerForm[] = ["single-choice", "true-false"];

export function getExamModeOrDefault(mode: ExamMode | undefined): ExamMode {
    return mode === "challenge" ? "challenge" : "simple";
}

export function isAnswerFormAllowedForMode(answerForm: ExamAnswerForm, mode: ExamMode): boolean {
    return mode === "challenge" || SIMPLE_EXAM_ANSWER_FORMS.includes(answerForm);
}

export function getQuestionAnswerForm(question: ExamQuestion): ExamAnswerForm {
    return question.answerForm ?? "free-response";
}

export function isObjectiveQuestion(question: ExamQuestion): question is ObjectiveExamQuestion {
    const answerForm: ExamAnswerForm = getQuestionAnswerForm(question);
    return (answerForm === "single-choice" || answerForm === "true-false")
        && Array.isArray(question.options)
        && typeof question.correctOptionId === "string";
}

/** 清理空选项，并保留每个 ID 和规范化文本第一次出现的顺序。 */
export function normalizeObjectiveOptions(
    rawOptions: readonly ExamChoiceOption[] | undefined,
): ExamChoiceOption[] {
    const seenIds = new Set<string>();
    const seenTexts = new Set<string>();
    const options: ExamChoiceOption[] = [];
    for (const option of rawOptions ?? []) {
        const id = option.id.trim();
        const text = option.text.trim();
        const normalizedText = text.normalize("NFKC").toLocaleLowerCase();
        if (!id || !text || seenIds.has(id) || seenTexts.has(normalizedText)) continue;
        seenIds.add(id);
        seenTexts.add(normalizedText);
        options.push({ id, text });
    }
    return options;
}
