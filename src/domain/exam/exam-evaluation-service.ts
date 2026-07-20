import type { JsonGenerationGateway } from "../model/json-generation-gateway";
import { generateParsedJsonAnswer } from "../model/structured-output-service";
import type { LocalChatMessage } from "../model/model-types";
import type {
    AssessmentErrorCode,
    ExamEvaluation,
    ExamEvaluationItem,
    ExamEvaluationMetadata,
    ExamQuestion,
    ExamSession,
} from "./exam-types";

/** Bump only when the evaluation prompt contract changes. */
export const EXAM_EVALUATION_PROMPT_VERSION = "exam-evaluation/v2";

const ASSESSMENT_ERROR_CODES: ReadonlySet<AssessmentErrorCode> = new Set<AssessmentErrorCode>([
    "missing-key-point",
    "concept-confusion",
    "incorrect-causal-relation",
    "incorrect-definition",
    "incomplete-process",
    "incorrect-application",
    "unsupported-claim",
    "irrelevant-answer",
    "no-answer",
    "other",
]);

/** Model payload for one evaluated question. */
interface ExamEvaluationItemPayload {
    id?: string;
    question_id?: string;
    score?: unknown;
    max_score?: unknown;
    feedback?: string;
    improvement?: string;
    covered_key_points?: unknown;
    missing_key_points?: unknown;
    error_codes?: unknown;
    evaluation_confidence?: unknown;
}

/** Model payload for a complete exam evaluation. */
interface ExamEvaluationPayload {
    score?: unknown;
    max_score?: unknown;
    overall_feedback?: string;
    items?: ExamEvaluationItemPayload[];
}

const EVALUATION_JSON_REPAIR_INSTRUCTIONS: readonly string[] = [
    "你是一个严格 JSON 修复器。",
    "你的任务是把用户提供的模型输出修复为可以被 JSON.parse 解析的 JSON。",
    "必须遵守：",
    "1. 只输出 JSON 对象，不要输出 Markdown、解释或代码块。",
    "2. 不要新增、删除或改写字段含义。",
    "3. 修复未转义双引号、字符串内部原始换行、尾随逗号等语法问题。",
    "4. 如果某个字符串需要换行，请改为普通空格或使用 \\n 转义。",
    "5. 输出必须符合用户给出的 schema。",
];

/**
 * Scores an exam without mutating or persisting its session.
 */
export class ExamEvaluationService {
    private readonly jsonGateway: JsonGenerationGateway;

    constructor(jsonGateway: JsonGenerationGateway) {
        this.jsonGateway = jsonGateway;
    }

    /**
     * Evaluate the submitted answers and return only the normalized result.
     */
    async evaluate(
        session: ExamSession,
        userAnswers: readonly string[],
        evaluator: ExamEvaluationMetadata,
    ): Promise<ExamEvaluation> {
        const answerBlocks: string[] = session.questions.map((question: ExamQuestion, index: number) => {
            const userAnswer: string = userAnswers[index]?.trim() ?? "";
            return [
                `## ${question.id}`,
                `题目：${question.question}`,
                `参考答案：${question.referenceAnswer}`,
                `评分标准：${question.rubric}`,
                `用户答案：${userAnswer.length > 0 ? userAnswer : "（未作答）"}`,
            ].join("\n");
        });
        const messages: LocalChatMessage[] = [
            {
                role: "system",
                content: [
                    "你是 VaultCoach 的考试评分器。",
                    "你的任务是根据题目、参考答案、评分标准和用户答案进行稳定评分。",
                    "必须遵守：",
                    "1. 只评价用户答案是否覆盖参考答案中的关键点。",
                    "2. 不要因为表达方式不同而扣分，只要含义正确即可。",
                    "3. 未作答或明显无关答案应给低分。",
                    "4. 每题 max_score 必须是 100，score 必须是 0 到 100 的数字。",
                    "5. 总分 score 是所有题目百分制得分的平均值，max_score 必须是 100。",
                    "6. 输出严格 JSON，不要使用 Markdown，不要包裹代码块。",
                    "7. 所有字符串必须是合法 JSON string；不要在字符串内部直接换行。",
                    "8. 字段值中不要使用未转义的英文双引号；需要引用时优先使用中文引号或单引号。",
                    "9. 每题必须提供 covered_key_points、missing_key_points、error_codes 和 0 到 1 的 evaluation_confidence。",
                    "10. error_codes 只能使用：missing-key-point、concept-confusion、incorrect-causal-relation、incorrect-definition、incomplete-process、incorrect-application、unsupported-claim、irrelevant-answer、no-answer、other。",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    `测试标题：${session.title}`,
                    `题目数量：${session.questions.length}`,
                    "",
                    "请输出 JSON，schema 如下：",
                    this.buildJsonSchemaDescription(),
                    "",
                    "待评分内容：",
                    answerBlocks.join("\n\n"),
                ].join("\n"),
            },
        ];

        const payload: ExamEvaluationPayload = await generateParsedJsonAnswer<ExamEvaluationPayload>(
            this.jsonGateway,
            messages,
            0,
            this.buildJsonSchemaDescription(),
            "考试评分",
            undefined,
            EVALUATION_JSON_REPAIR_INSTRUCTIONS,
        );
        return this.normalizeEvaluation(payload, session.questions, userAnswers, evaluator);
    }

    /** Normalize a model payload while preserving the current scoring contract. */
    private normalizeEvaluation(
        payload: ExamEvaluationPayload,
        questions: ExamQuestion[],
        userAnswers: readonly string[],
        evaluator: ExamEvaluationMetadata,
    ): ExamEvaluation {
        const itemPayloads: ExamEvaluationItemPayload[] = Array.isArray(payload.items) ? payload.items : [];
        const items: ExamEvaluationItem[] = questions.map((question: ExamQuestion, index: number) => {
            const payloadItem: ExamEvaluationItemPayload | undefined = itemPayloads.find((item: ExamEvaluationItemPayload) => {
                return item.question_id === question.id || item.id === question.id;
            }) ?? itemPayloads[index];

            return {
                questionId: question.id,
                score: this.clampScore(payloadItem?.score ?? 0, 0, 100),
                maxScore: 100,
                feedback: this.normalizeText(payloadItem?.feedback, "未提供本题反馈。"),
                improvement: this.normalizeText(payloadItem?.improvement, "请对照参考答案补全关键点。"),
                coveredKeyPoints: this.normalizeTextArray(payloadItem?.covered_key_points),
                missingKeyPoints: this.normalizeTextArray(payloadItem?.missing_key_points),
                errorCodes: this.normalizeErrorCodes(
                    payloadItem?.error_codes,
                    (userAnswers[index] ?? "").trim().length === 0,
                ),
                evaluationConfidence: this.clampConfidence(payloadItem?.evaluation_confidence),
                evaluator: { ...evaluator },
            };
        });
        const scoreFromItems: number = items.length > 0
            ? Math.round(items.reduce((sum: number, item: ExamEvaluationItem) => {
                return sum + (item.score / Math.max(1, item.maxScore)) * (100 / items.length);
            }, 0))
            : 0;

        return {
            score: this.clampScore(payload.score ?? scoreFromItems, 0, 100),
            maxScore: 100,
            overallFeedback: this.normalizeText(payload.overall_feedback, "评分完成。"),
            items,
        };
    }

    /** JSON schema included in the evaluation prompt and repair prompt. */
    private buildJsonSchemaDescription(): string {
        return [
            "{",
            "  \"score\": 82,",
            "  \"max_score\": 100,",
            "  \"overall_feedback\": \"总体反馈\",",
            "  \"items\": [",
            "    {",
            "      \"question_id\": \"q1\",",
            "      \"score\": 80,",
            "      \"max_score\": 100,",
            "      \"feedback\": \"本题反馈\",",
            "      \"improvement\": \"改进建议\",",
            "      \"covered_key_points\": [\"已覆盖的关键点\"],",
            "      \"missing_key_points\": [\"待补足的关键点\"],",
            "      \"error_codes\": [\"missing-key-point\"],",
            "      \"evaluation_confidence\": 0.85",
            "    }",
            "  ]",
            "}",
        ].join("\n");
    }

    /** Clamp scores to the stable integer 0–100 contract. */
    private clampScore(value: unknown, min: number, max: number): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return min;
        }

        return Math.max(min, Math.min(max, Math.round(value)));
    }

    /** Normalize a model string while retaining the existing fallback copy. */
    private normalizeText(value: string | undefined, fallback: string): string {
        if (typeof value !== "string") {
            return fallback;
        }

        const trimmedValue: string = value.trim();
        return trimmedValue.length > 0 ? trimmedValue : fallback;
    }

    /** Normalizes model key-point fields without letting malformed values enter the domain. */
    private normalizeTextArray(value: unknown): string[] {
        const values: unknown[] = Array.isArray(value) ? value : [value];
        return Array.from(new Set(values
            .filter((item: unknown): item is string => typeof item === "string")
            .map((item: string) => item.trim())
            .filter((item: string) => item.length > 0)));
    }

    /** Converts untrusted model labels to the closed assessment-error vocabulary. */
    private normalizeErrorCodes(value: unknown, isNoAnswer: boolean): AssessmentErrorCode[] {
        const values: unknown[] = Array.isArray(value)
            ? value
            : (typeof value === "string" ? value.split(/[,，、;；\n]+/g) : []);
        const normalizedCodes: AssessmentErrorCode[] = [];

        for (const valueItem of values) {
            if (typeof valueItem !== "string") {
                continue;
            }

            const code: string = valueItem.trim().toLowerCase();
            if (code.length === 0) {
                continue;
            }

            normalizedCodes.push(ASSESSMENT_ERROR_CODES.has(code as AssessmentErrorCode)
                ? code as AssessmentErrorCode
                : "other");
        }

        if (isNoAnswer) {
            normalizedCodes.push("no-answer");
        }

        return Array.from(new Set(normalizedCodes));
    }

    /** Evaluation confidence is a probability and must remain inside the closed 0–1 range. */
    private clampConfidence(value: unknown): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return 0;
        }

        return Math.max(0, Math.min(1, value));
    }
}
