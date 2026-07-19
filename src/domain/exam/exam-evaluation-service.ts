import type { JsonGenerationGateway } from "../model/json-generation-gateway";
import { generateParsedJsonAnswer } from "../model/structured-output-service";
import type { LocalChatMessage } from "../model/model-types";
import type { ExamEvaluation, ExamEvaluationItem, ExamQuestion, ExamSession } from "./exam-types";

/** Model payload for one evaluated question. */
interface ExamEvaluationItemPayload {
    id?: string;
    question_id?: string;
    score?: number;
    max_score?: number;
    feedback?: string;
    improvement?: string;
}

/** Model payload for a complete exam evaluation. */
interface ExamEvaluationPayload {
    score?: number;
    max_score?: number;
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
    async evaluate(session: ExamSession, userAnswers: readonly string[]): Promise<ExamEvaluation> {
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
        return this.normalizeEvaluation(payload, session.questions);
    }

    /** Normalize a model payload while preserving the current scoring contract. */
    private normalizeEvaluation(payload: ExamEvaluationPayload, questions: ExamQuestion[]): ExamEvaluation {
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
            "      \"improvement\": \"改进建议\"",
            "    }",
            "  ]",
            "}",
        ].join("\n");
    }

    /** Clamp scores to the stable integer 0–100 contract. */
    private clampScore(value: number, min: number, max: number): number {
        if (!Number.isFinite(value)) {
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
}
