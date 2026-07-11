import type {
    ExamQuestionReview,
    GeneratedExamQuestionCandidate,
    IndexedChunk,
} from "../types";
import {
    normalizeWhitespace,
    stripInternalExamLabels,
    throwIfAborted,
} from "./exam-utils";

export interface ExamCandidateValidation {
    candidate: GeneratedExamQuestionCandidate;
    review: ExamQuestionReview;
}

export class ExamQuestionValidator {
    async validateCandidates(
        candidates: GeneratedExamQuestionCandidate[],
        chunksById: Map<string, IndexedChunk>,
        acceptedQuestionFingerprints: Set<string>,
        abortSignal?: AbortSignal,
    ): Promise<ExamCandidateValidation[]> {
        throwIfAborted(abortSignal);
        const deterministicResults: ExamCandidateValidation[] = candidates.map((candidate: GeneratedExamQuestionCandidate) => {
            return {
                candidate,
                review: this.validateCandidateDeterministically(candidate, chunksById, acceptedQuestionFingerprints),
            };
        });
        return deterministicResults;
    }

    normalizeCandidate(candidate: GeneratedExamQuestionCandidate): GeneratedExamQuestionCandidate {
        return {
            ...candidate,
            question: stripInternalExamLabels(normalizeWhitespace(candidate.question)),
            referenceAnswer: stripInternalExamLabels(normalizeWhitespace(candidate.referenceAnswer)),
            rubric: this.normalizeRubricText(stripInternalExamLabels(normalizeWhitespace(candidate.rubric))),
            sourceChunkIds: this.normalizeStringArray(candidate.sourceChunkIds),
            evidenceExcerptIds: this.normalizeStringArray(candidate.evidenceExcerptIds),
        };
    }

    createQuestionFingerprint(question: unknown): string {
        return normalizeWhitespace(question)
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "")
            .slice(0, 100);
    }

    private validateCandidateDeterministically(
        rawCandidate: GeneratedExamQuestionCandidate,
        chunksById: Map<string, IndexedChunk>,
        acceptedQuestionFingerprints: Set<string>,
    ): ExamQuestionReview {
        const candidate: GeneratedExamQuestionCandidate = this.normalizeCandidate(rawCandidate);
        const failureCodes: string[] = [];

        if (candidate.question.length < 8) {
            failureCodes.push("empty-or-short-question");
        }

        if (candidate.referenceAnswer.length < 8) {
            failureCodes.push("reference-answer-too-short");
        }

        if (candidate.rubric.length < 18) {
            failureCodes.push("rubric-too-short");
        }

        const sourceChunkIds: string[] = candidate.sourceChunkIds.filter((chunkId: string) => chunksById.has(chunkId));
        if (sourceChunkIds.length === 0) {
            failureCodes.push("invalid-source-chunk");
        }

        if (this.containsInternalTrace(candidate.question) || this.containsInternalTrace(candidate.referenceAnswer) || this.containsInternalTrace(candidate.rubric)) {
            failureCodes.push("internal-label-leak");
        }

        if (!/100\s*分|百分制|100-point|out of 100/i.test(candidate.rubric)) {
            failureCodes.push("rubric-not-100-point");
        }

        if (this.questionLeaksReferenceAnswer(candidate.question, candidate.referenceAnswer)) {
            failureCodes.push("question-leaks-answer");
        }

        if (/根据(上述|给定)?(上下文|材料|片段)\s*\d*/.test(candidate.question) || /context\s*\d+/i.test(candidate.question)) {
            failureCodes.push("prompt-trace");
        }

        const fingerprint: string = this.createQuestionFingerprint(candidate.question);
        if (fingerprint.length > 0 && acceptedQuestionFingerprints.has(fingerprint)) {
            failureCodes.push("duplicated-question");
        }

        const passed: boolean = failureCodes.length === 0;
        return {
            questionId: this.getCandidateQuestionId(candidate),
            passed,
            groundedness: sourceChunkIds.length > 0 ? 0.75 : 0,
            answerability: candidate.referenceAnswer.length >= 8 ? 0.75 : 0,
            learningValue: candidate.question.length >= 8 ? 0.65 : 0,
            clarity: candidate.question.length >= 8 ? 0.75 : 0,
            uniqueness: failureCodes.includes("duplicated-question") ? 0 : 0.75,
            failureCodes,
            repairInstruction: passed ? "" : this.buildRepairInstruction(failureCodes),
        };
    }

    private containsInternalTrace(value: unknown): boolean {
        return /EXCERPT_ID|SOURCE_PATH|SOURCE_CHUNK_IDS?|BLUEPRINT_ITEM|HEADING:|\bE\d+\b/i.test(normalizeWhitespace(value));
    }

    private questionLeaksReferenceAnswer(question: unknown, referenceAnswer: unknown): boolean {
        const normalizedQuestion: string = normalizeWhitespace(question).toLowerCase().replace(/\s+/g, "");
        const answerParts: string[] = normalizeWhitespace(referenceAnswer)
            .split(/[。；;,.，\n]/g)
            .map((part: string) => part.trim())
            .filter((part: string) => part.length >= 18);

        return answerParts.some((part: string) => normalizedQuestion.includes(part.toLowerCase().replace(/\s+/g, "").slice(0, 40)));
    }

    private normalizeRubricText(value: unknown): string {
        const cleanedValue: string = normalizeWhitespace(value)
            .replace(/满分\s*\d+\s*分/g, "满分 100 分")
            .replace(/总分\s*\d+\s*分/g, "总分 100 分")
            .replace(/每(?:个|点|项)?\s*\d+\s*分/g, "按覆盖程度给分")
            .trim();

        if (cleanedValue.length === 0) {
            return "本题按 100 分制评分；答案准确性 50 分，关键概念覆盖 30 分，表达清晰与逻辑完整 20 分。";
        }

        if (/100\s*分|百分制|100-point|out of 100/i.test(cleanedValue)) {
            return cleanedValue;
        }

        return `本题按 100 分制评分；${cleanedValue}`;
    }

    private buildRepairInstruction(failureCodes: string[]): string {
        if (failureCodes.includes("invalid-source-chunk")) {
            return "必须只使用蓝图指定的真实 source_chunk_ids 生成题目。";
        }

        if (failureCodes.includes("duplicated-question")) {
            return "请换一个考察角度，避免与已通过题目重复。";
        }

        if (failureCodes.includes("reference-answer-too-short")) {
            return "参考答案需要给出可评分的关键点，不能只有一句泛泛描述。";
        }

        if (failureCodes.includes("rubric-not-100-point")) {
            return "评分标准必须明确采用 100 分制。";
        }

        return "请基于相同来源重新生成更清晰、可回答且有学习价值的问题。";
    }

    private getCandidateQuestionId(candidate: GeneratedExamQuestionCandidate): string {
        return candidate.id?.trim() || candidate.blueprintItemId;
    }

    private normalizeStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return Array.from(new Set(
            value
                .map((item: unknown) => normalizeWhitespace(item))
                .filter((item: string) => item.length > 0),
        ));
    }

}
