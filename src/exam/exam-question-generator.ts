import { LocalModelClient } from "../model-client";
import type {
    ExamBlueprint,
    ExamBlueprintItem,
    ExamQuestion,
    GeneratedExamQuestionCandidate,
    IndexedChunk,
    LocalChatMessage,
    VaultCoachSettings,
} from "../types";
import { generateParsedJsonAnswer, normalizeWhitespace, throwIfAborted } from "./exam-utils";
import { ExamCandidateValidation, ExamQuestionValidator } from "./exam-question-validator";

/**
 * 考试题目生成模块。
 *
 * 根据蓝图分批调用模型生成题目，再交给校验器过滤质量问题。
 * 对于模型失败或结构不可用的题目，会基于来源 chunk 生成确定性兜底题。
 */

/**
 * 模型返回的题目候选结构。
 */
interface GeneratedExamQuestionPayload {
    [key: string]: unknown;
    id?: unknown;
    blueprint_item_id?: unknown;
    question?: unknown;
    reference_answer?: unknown;
    rubric?: unknown;
    source_chunk_ids?: unknown;
    evidence_excerpt_ids?: unknown;
}

/**
 * 题目生成结果及诊断计数。
 */
export interface ExamQuestionGenerationResult {
    questions: ExamQuestion[];
    firstPassQuestions: number;
    repairedQuestions: number;
}

/**
 * 考试题目生成器。
 */
export class ExamQuestionGenerator {
    private readonly client: LocalModelClient;
    private readonly validator: ExamQuestionValidator;
    private readonly getSettings: () => VaultCoachSettings;

    constructor(
        client: LocalModelClient,
        validator: ExamQuestionValidator,
        getSettings: () => VaultCoachSettings,
    ) {
        this.client = client;
        this.validator = validator;
        this.getSettings = getSettings;
    }

    /**
     * 根据蓝图生成最终考试题列表。
     */
    async generateQuestions(
        blueprint: ExamBlueprint,
        chunks: IndexedChunk[],
        abortSignal?: AbortSignal,
        onProgress?: (current: number, total: number) => void,
    ): Promise<ExamQuestionGenerationResult> {
        const chunksById: Map<string, IndexedChunk> = new Map<string, IndexedChunk>(
            chunks.map((chunk: IndexedChunk) => [chunk.id, chunk]),
        );
        const acceptedCandidates: GeneratedExamQuestionCandidate[] = [];
        const acceptedFingerprints: Set<string> = new Set<string>();
        const generatedCandidates: GeneratedExamQuestionCandidate[] = [];
        const batches: ExamBlueprintItem[][] = this.chunkArray(blueprint.items, this.getBatchSize());

        for (const batch of batches) {
            throwIfAborted(abortSignal);
            let batchCandidates: GeneratedExamQuestionCandidate[] = [];
            try {
                batchCandidates = await this.generateCandidateBatch(
                    blueprint,
                    batch,
                    chunksById,
                    abortSignal,
                );
            } catch (error: unknown) {
                if (this.isAbortError(error)) {
                    throw error;
                }
                console.warn("[VaultCoach] 考试题目模型生成失败，将使用来源片段兜底生成。", error);
            }

            if (batchCandidates.length === 0) {
                batchCandidates = batch.map((item: ExamBlueprintItem) => {
                    return this.buildDeterministicCandidate(item, chunksById);
                });
            }

            generatedCandidates.push(...batchCandidates);
            onProgress?.(Math.min(generatedCandidates.length, blueprint.items.length), blueprint.items.length);
        }

        const validationResults: ExamCandidateValidation[] = await this.validator.validateCandidates(
            generatedCandidates,
            chunksById,
            acceptedFingerprints,
            abortSignal,
        );
        this.logValidationSummary(0, validationResults);
        const validationByBlueprintItemId: Map<string, ExamCandidateValidation> = new Map<string, ExamCandidateValidation>();
        for (const validationResult of validationResults) {
            validationByBlueprintItemId.set(validationResult.candidate.blueprintItemId, validationResult);
        }

        let fallbackQuestions = 0;
        for (const item of blueprint.items) {
            const validationResult: ExamCandidateValidation | undefined = validationByBlueprintItemId.get(item.id);
            const acceptedCandidate: GeneratedExamQuestionCandidate = this.selectAcceptedCandidate(
                item,
                validationResult,
                chunksById,
            );
            const uniqueCandidate: GeneratedExamQuestionCandidate = this.ensureUniqueQuestion(
                acceptedCandidate,
                item,
                chunksById,
                acceptedFingerprints,
            );
            if (!validationResult?.review.passed) {
                fallbackQuestions += 1;
            }
            acceptedCandidates.push(uniqueCandidate);
        }

        return {
            questions: acceptedCandidates.map((candidate: GeneratedExamQuestionCandidate, index: number) => {
                return this.convertCandidateToQuestion(candidate, chunksById, index + 1);
            }),
            firstPassQuestions: generatedCandidates.length,
            repairedQuestions: fallbackQuestions,
        };
    }

    /**
     * 对一批蓝图项调用模型生成题目候选。
     */
    private async generateCandidateBatch(
        blueprint: ExamBlueprint,
        items: ExamBlueprintItem[],
        chunksById: Map<string, IndexedChunk>,
        abortSignal?: AbortSignal,
    ): Promise<GeneratedExamQuestionCandidate[]> {
        const messages: LocalChatMessage[] = [
            {
                role: "system",
                content: [
                    "你是 VaultCoach 的考试出题器。",
                    "你的任务是严格根据蓝图和来源 chunk 生成题目。",
                    "必须遵守：",
                    "1. 每个 blueprint_item_id 生成一道题。",
                    "2. 只根据提供的来源出题，不引入外部事实。",
                    "3. 题目应考察理解、解释、比较、推理、流程或应用，不要机械复述原句。",
                    "4. 参考答案必须能从来源完整得出。",
                    "5. 评分标准必须是 100 分制。",
                    "6. 不要在题目、答案或评分标准中出现 EXCERPT_ID、SOURCE_PATH、HEADING、CHUNK_ID、BLUEPRINT_ITEM 等内部标记。",
                    "7. 只输出 JSON，不要输出 Markdown、解释或代码块。",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    `考试蓝图标题：${blueprint.title}`,
                    "",
                    "蓝图项与来源：",
                    items.map((item: ExamBlueprintItem) => this.buildBlueprintItemGenerationBlock(item, chunksById)).join("\n\n"),
                    "",
                    "请输出 JSON：",
                    this.buildQuestionSchema(),
                ].join("\n"),
            },
        ];

        const payload: unknown = await generateParsedJsonAnswer<unknown>(
            this.client,
            messages,
            0.1,
            this.buildQuestionSchema(),
            "考试题目生成",
            abortSignal,
        );
        const payloadQuestions: GeneratedExamQuestionPayload[] = this.extractQuestionPayloads(payload);
        return this.normalizeQuestionPayloads(payloadQuestions, items);
    }

    /**
     * 从模型返回中提取题目数组。
     *
     * 兼容常见英文、驼峰和中文字段名，提高不同模型输出的容错性。
     */
    private extractQuestionPayloads(payload: unknown): GeneratedExamQuestionPayload[] {
        const rawQuestions: unknown = Array.isArray(payload)
            ? payload
            : this.readRecordValue(
                this.asRecord(payload),
                ["questions", "items", "question_items", "questionItems", "题目", "试题"],
            );

        if (!Array.isArray(rawQuestions)) {
            return [];
        }

        return rawQuestions.filter((question: unknown): question is GeneratedExamQuestionPayload => {
            return question !== null && typeof question === "object";
        });
    }

    /**
     * 输出校验失败统计，便于开发调试题目质量。
     */
    private logValidationSummary(attempt: number, validationResults: ExamCandidateValidation[]): void {
        const failedResults: ExamCandidateValidation[] = validationResults.filter((result: ExamCandidateValidation) => !result.review.passed);
        if (failedResults.length === 0) {
            return;
        }

        const failureCodeCounts: Record<string, number> = {};
        for (const result of failedResults) {
            for (const failureCode of result.review.failureCodes) {
                failureCodeCounts[failureCode] = (failureCodeCounts[failureCode] ?? 0) + 1;
            }
        }

        console.debug("[VaultCoach] Exam question validation failures", {
            attempt,
            total: validationResults.length,
            failed: failedResults.length,
            failureCodeCounts,
        });
    }

    /**
     * 将模型返回字段归一化为内部题目候选。
     */
    private normalizeQuestionPayloads(
        payloadQuestions: GeneratedExamQuestionPayload[],
        items: ExamBlueprintItem[],
    ): GeneratedExamQuestionCandidate[] {
        const candidates: GeneratedExamQuestionCandidate[] = [];
        const itemById: Map<string, ExamBlueprintItem> = new Map<string, ExamBlueprintItem>(
            items.map((item: ExamBlueprintItem) => [item.id, item]),
        );

        for (let index = 0; index < payloadQuestions.length; index += 1) {
            const payload: GeneratedExamQuestionPayload | undefined = payloadQuestions[index];
            if (!payload) {
                continue;
            }

            const fallbackItem: ExamBlueprintItem | undefined = items[index];
            const payloadRecord: Record<string, unknown> = this.asRecord(payload);
            const blueprintItemId: string = normalizeWhitespace(this.readRecordValue(payloadRecord, [
                "blueprint_item_id",
                "blueprintItemId",
                "blueprint_id",
                "blueprintId",
                "item_id",
                "itemId",
                "蓝图项ID",
                "蓝图项",
            ])) || fallbackItem?.id || "";
            const item: ExamBlueprintItem | undefined = itemById.get(blueprintItemId) ?? fallbackItem;
            if (!item) {
                continue;
            }

            candidates.push({
                id: normalizeWhitespace(this.readRecordValue(payloadRecord, ["id", "question_id", "questionId", "题目ID"])) || `q-${item.id}`,
                blueprintItemId: item.id,
                question: this.normalizeTextValue(this.readRecordValue(payloadRecord, [
                    "question",
                    "prompt",
                    "stem",
                    "title",
                    "题目",
                    "问题",
                    "提问",
                ])),
                referenceAnswer: this.normalizeTextValue(this.readRecordValue(payloadRecord, [
                    "reference_answer",
                    "referenceAnswer",
                    "answer",
                    "reference",
                    "sample_answer",
                    "sampleAnswer",
                    "model_answer",
                    "modelAnswer",
                    "标准答案",
                    "参考答案",
                    "答案",
                ])),
                rubric: this.normalizeTextValue(this.readRecordValue(payloadRecord, [
                    "rubric",
                    "scoring_rubric",
                    "scoringRubric",
                    "grading_rubric",
                    "gradingRubric",
                    "criteria",
                    "grading_criteria",
                    "gradingCriteria",
                    "评分标准",
                    "评分细则",
                    "判分标准",
                ])),
                sourceChunkIds: this.normalizeSourceChunkIds(this.readRecordValue(payloadRecord, [
                    "source_chunk_ids",
                    "sourceChunkIds",
                    "source_chunks",
                    "sourceChunks",
                    "chunk_ids",
                    "chunkIds",
                    "source_ids",
                    "sourceIds",
                    "来源chunk",
                    "来源片段",
                ]), item.sourceChunkIds),
                evidenceExcerptIds: this.normalizeStringArray(this.readRecordValue(payloadRecord, [
                    "evidence_excerpt_ids",
                    "evidenceExcerptIds",
                    "excerpt_ids",
                    "excerptIds",
                    "evidence",
                    "证据片段",
                ]), []),
            });
        }

        return candidates;
    }

    /**
     * 归一化来源 chunk ID，只保留蓝图允许的来源。
     */
    private normalizeSourceChunkIds(rawValue: unknown, fallback: string[]): string[] {
        const fallbackSet: Set<string> = new Set(fallback);
        const rawValues: unknown[] = this.normalizeRawArray(rawValue);
        if (rawValues.length === 0) {
            return [...fallback];
        }

        const values: string[] = rawValues
            .map((value: unknown) => this.extractIdLikeValue(value))
            .filter((value: string) => value.length > 0 && fallbackSet.has(value));

        return values.length > 0 ? Array.from(new Set(values)) : [...fallback];
    }

    /**
     * 归一化字符串数组字段。
     */
    private normalizeStringArray(rawValue: unknown, fallback: string[]): string[] {
        const rawValues: unknown[] = this.normalizeRawArray(rawValue);
        if (rawValues.length === 0) {
            return [...fallback];
        }

        const values: string[] = rawValues
            .map((value: unknown) => this.extractIdLikeValue(value))
            .filter((value: string) => value.length > 0);

        return values.length > 0 ? Array.from(new Set(values)) : [...fallback];
    }

    /**
     * 选择可接受的候选题。
     *
     * 完全通过校验的候选优先；结构基本可用的候选次之；否则使用确定性兜底题。
     */
    private selectAcceptedCandidate(
        item: ExamBlueprintItem,
        validationResult: ExamCandidateValidation | undefined,
        chunksById: Map<string, IndexedChunk>,
    ): GeneratedExamQuestionCandidate {
        if (validationResult?.review.passed) {
            return this.validator.normalizeCandidate(validationResult.candidate);
        }

        if (validationResult && this.isStructurallyUsableCandidate(validationResult.candidate, chunksById)) {
            return this.validator.normalizeCandidate(validationResult.candidate);
        }

        return this.buildDeterministicCandidate(item, chunksById);
    }

    /**
     * 判断候选题是否至少具备可展示和可评分的基本结构。
     */
    private isStructurallyUsableCandidate(
        candidate: GeneratedExamQuestionCandidate,
        chunksById: Map<string, IndexedChunk>,
    ): boolean {
        const normalizedCandidate: GeneratedExamQuestionCandidate = this.validator.normalizeCandidate(candidate);
        const hasValidSource: boolean = normalizedCandidate.sourceChunkIds.some((chunkId: string) => chunksById.has(chunkId));
        return hasValidSource
            && normalizedCandidate.question.length >= 8
            && normalizedCandidate.referenceAnswer.length >= 8;
    }

    /**
     * 确保题目在本场考试内不重复。
     */
    private ensureUniqueQuestion(
        candidate: GeneratedExamQuestionCandidate,
        item: ExamBlueprintItem,
        chunksById: Map<string, IndexedChunk>,
        acceptedFingerprints: Set<string>,
    ): GeneratedExamQuestionCandidate {
        const fingerprint: string = this.validator.createQuestionFingerprint(candidate.question);
        if (fingerprint.length === 0 || !acceptedFingerprints.has(fingerprint)) {
            if (fingerprint.length > 0) {
                acceptedFingerprints.add(fingerprint);
            }
            return candidate;
        }

        const sourceLabel: string = this.getSourceLabel(item, chunksById);
        const uniqueCandidate: GeneratedExamQuestionCandidate = {
            ...candidate,
            question: `${candidate.question} 请结合「${sourceLabel}」中的具体内容作答。`,
        };
        const uniqueFingerprint: string = this.validator.createQuestionFingerprint(uniqueCandidate.question);
        if (uniqueFingerprint.length > 0) {
            acceptedFingerprints.add(uniqueFingerprint);
        }

        return uniqueCandidate;
    }

    /**
     * 基于蓝图和来源 chunk 生成兜底题目候选。
     */
    private buildDeterministicCandidate(
        item: ExamBlueprintItem,
        chunksById: Map<string, IndexedChunk>,
    ): GeneratedExamQuestionCandidate {
        const sourceChunks: IndexedChunk[] = item.sourceChunkIds
            .map((chunkId: string) => chunksById.get(chunkId))
            .filter((chunk: IndexedChunk | undefined): chunk is IndexedChunk => chunk !== undefined);
        const sourceChunkIds: string[] = sourceChunks.length > 0
            ? sourceChunks.map((chunk: IndexedChunk) => chunk.id)
            : [...item.sourceChunkIds];
        const topic: string = normalizeWhitespace(item.topic)
            || sourceChunks[0]?.primaryHeading
            || sourceChunks[0]?.fileName.replace(/\.md$/i, "")
            || "当前主题";
        const sourceText: string = this.buildSourceAnswerText(sourceChunks, topic);

        return {
            id: `q-${item.id}`,
            blueprintItemId: item.id,
            question: this.buildDeterministicQuestion(item, topic),
            referenceAnswer: sourceText,
            rubric: "本题按 100 分制评分；核心概念和事实准确 45 分，关键步骤或关系覆盖 30 分，能结合来源进行解释或应用 15 分，表达清晰有条理 10 分。",
            sourceChunkIds,
            evidenceExcerptIds: [],
        };
    }

    /**
     * 根据题型生成确定性题干。
     */
    private buildDeterministicQuestion(item: ExamBlueprintItem, topic: string): string {
        switch (item.questionType) {
            case "comparison":
                return `请比较「${topic}」中涉及的关键概念、做法或条件，并说明它们的联系与差异。`;
            case "application":
                return `如果要把「${topic}」应用到实际笔记或项目中，你会如何操作？请结合关键步骤说明。`;
            case "reasoning":
                return `为什么「${topic}」中的做法或结论成立？请说明背后的原因和关键依据。`;
            case "process":
                return `请按顺序说明「${topic}」的主要流程、步骤或组成部分。`;
            case "explanation":
            default:
                return `请解释「${topic}」的核心内容，并概括其中最重要的要点。`;
        }
    }

    /**
     * 从来源 chunk 构造兜底参考答案。
     */
    private buildSourceAnswerText(sourceChunks: IndexedChunk[], topic: string): string {
        const sourceText: string = normalizeWhitespace(sourceChunks.map((chunk: IndexedChunk) => chunk.text).join(" "));
        const excerpt: string = sourceText.length > 520
            ? `${sourceText.slice(0, 520)}...`
            : sourceText;

        if (excerpt.length > 0) {
            return `应围绕「${topic}」作答，关键依据包括：${excerpt}`;
        }

        return `应围绕「${topic}」说明来源中的核心概念、关键步骤、适用条件和结论，并保持答案与考试范围一致。`;
    }

    /**
     * 获取题目去重时用于区分来源的标签。
     */
    private getSourceLabel(item: ExamBlueprintItem, chunksById: Map<string, IndexedChunk>): string {
        const chunk: IndexedChunk | undefined = chunksById.get(item.sourceChunkIds[0] ?? "");
        return chunk?.primaryHeading
            || chunk?.fileName.replace(/\.md$/i, "")
            || normalizeWhitespace(item.topic)
            || item.id;
    }

    /**
     * 将模型可能返回的字符串、数组或对象归一化为文本。
     */
    private normalizeTextValue(value: unknown): string {
        if (Array.isArray(value)) {
            return value
                .map((item: unknown) => this.normalizeTextValue(item))
                .filter((item: string) => item.length > 0)
                .join("；");
        }

        if (this.isRecord(value)) {
            const normalizedItems: string[] = [];
            for (const key of Object.keys(value)) {
                const normalizedItem: string = this.normalizeTextValue(value[key]);
                if (normalizedItem.length > 0) {
                    normalizedItems.push(normalizedItem);
                }
            }
            return normalizedItems.join("；");
        }

        return normalizeWhitespace(value);
    }

    /**
     * 将字符串或数组形式的模型字段统一转为数组。
     */
    private normalizeRawArray(rawValue: unknown): unknown[] {
        if (Array.isArray(rawValue)) {
            return rawValue;
        }

        if (typeof rawValue === "string") {
            return rawValue.split(/[,\n，、;；\s]+/g);
        }

        return [];
    }

    /**
     * 从字符串或对象中提取类似 ID 的字段。
     */
    private extractIdLikeValue(value: unknown): string {
        if (value !== null && typeof value === "object") {
            return normalizeWhitespace(this.readRecordValue(this.asRecord(value), ["id", "chunk_id", "chunkId", "excerpt_id", "excerptId"]));
        }

        return normalizeWhitespace(value);
    }

    /**
     * 按多个候选 key 读取对象字段，并兼容大小写差异。
     */
    private readRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(record, key)) {
                return record[key];
            }
        }

        const normalizedKeys: Set<string> = new Set<string>(keys.map((key: string) => key.toLowerCase()));
        for (const recordKey of Object.keys(record)) {
            if (normalizedKeys.has(recordKey.toLowerCase())) {
                return record[recordKey];
            }
        }

        return undefined;
    }

    /**
     * 将 unknown 安全转换为 record。
     */
    private asRecord(value: unknown): Record<string, unknown> {
        return this.isRecord(value) ? value : {};
    }

    /**
     * 判断 unknown 是否为普通对象。
     */
    private isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /**
     * 将内部候选转换为最终考试题。
     */
    private convertCandidateToQuestion(
        candidate: GeneratedExamQuestionCandidate,
        chunksById: Map<string, IndexedChunk>,
        index: number,
    ): ExamQuestion {
        const sourcePaths: string[] = Array.from(new Set(
            candidate.sourceChunkIds
                .map((chunkId: string) => chunksById.get(chunkId)?.filePath)
                .filter((filePath: string | undefined): filePath is string => filePath !== undefined),
        ));

        return {
            id: `q${index}`,
            question: candidate.question,
            referenceAnswer: candidate.referenceAnswer,
            rubric: candidate.rubric,
            sourcePaths,
        };
    }

    /**
     * 构造单个蓝图项的模型输入块。
     */
    private buildBlueprintItemGenerationBlock(
        item: ExamBlueprintItem,
        chunksById: Map<string, IndexedChunk>,
    ): string {
        return [
            `BLUEPRINT_ITEM_ID: ${item.id}`,
            `TOPIC: ${item.topic}`,
            `LEARNING_OBJECTIVE: ${item.learningObjective}`,
            `QUESTION_TYPE: ${item.questionType}`,
            `DIFFICULTY: ${item.difficulty}`,
            "SOURCES:",
            item.sourceChunkIds.map((chunkId: string, index: number) => {
                const chunk: IndexedChunk | undefined = chunksById.get(chunkId);
                if (!chunk) {
                    return "";
                }

                return [
                    `<excerpt id="E${index + 1}">`,
                    `CHUNK_ID: ${chunk.id}`,
                    `SOURCE_PATH: ${chunk.filePath}`,
                    `HEADING: ${chunk.headingPath.length > 0 ? chunk.headingPath.join(" > ") : "（无标题）"}`,
                    "TEXT:",
                    this.truncateSourceText(chunk.text, 1800),
                    "</excerpt>",
                ].join("\n");
            }).filter((block: string) => block.length > 0).join("\n\n"),
        ].filter((line: string) => line.length > 0).join("\n");
    }

    /**
     * 生成题目 JSON schema 文本。
     */
    private buildQuestionSchema(): string {
        return [
            "{",
            "  \"questions\": [",
            "    {",
            "      \"id\": \"q-bp1\",",
            "      \"blueprint_item_id\": \"bp1\",",
            "      \"question\": \"题目\",",
            "      \"reference_answer\": \"参考答案\",",
            "      \"rubric\": \"本题按 100 分制评分；评分标准...\",",
            "      \"source_chunk_ids\": [\"真实 chunk id\"],",
            "      \"evidence_excerpt_ids\": [\"E1\"]",
            "    }",
            "  ]",
            "}",
        ].join("\n");
    }

    /**
     * 根据模型提供方决定每批生成多少题。
     */
    private getBatchSize(): number {
        const settings: VaultCoachSettings = this.getSettings();
        return settings.modelProvider === "openai-compatible" ? 6 : 5;
    }

    /**
     * 截断来源文本，避免单个批次 prompt 过长。
     */
    private truncateSourceText(value: string, maxLength: number): string {
        const normalizedValue: string = normalizeWhitespace(value);
        return normalizedValue.length > maxLength
            ? `${normalizedValue.slice(0, maxLength)}...`
            : normalizedValue;
    }

    /**
     * 将数组按固定大小切成批次。
     */
    private chunkArray<T>(items: T[], size: number): T[][] {
        const batches: T[][] = [];
        for (let index = 0; index < items.length; index += size) {
            batches.push(items.slice(index, index + size));
        }
        return batches;
    }

    /**
     * 判断错误是否来自取消操作。
     */
    private isAbortError(error: unknown): boolean {
        if (error instanceof DOMException) {
            return error.name === "AbortError";
        }

        if (error instanceof Error) {
            return error.name === "AbortError" || /aborted|aborterror/i.test(error.message);
        }

        return false;
    }
}
