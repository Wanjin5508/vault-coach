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

export interface ExamQuestionGenerationResult {
    questions: ExamQuestion[];
    firstPassQuestions: number;
    repairedQuestions: number;
}

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

    private getSourceLabel(item: ExamBlueprintItem, chunksById: Map<string, IndexedChunk>): string {
        const chunk: IndexedChunk | undefined = chunksById.get(item.sourceChunkIds[0] ?? "");
        return chunk?.primaryHeading
            || chunk?.fileName.replace(/\.md$/i, "")
            || normalizeWhitespace(item.topic)
            || item.id;
    }

    private normalizeTextValue(value: unknown): string {
        if (Array.isArray(value)) {
            return value
                .map((item: unknown) => this.normalizeTextValue(item))
                .filter((item: string) => item.length > 0)
                .join("；");
        }

        if (value !== null && typeof value === "object") {
            return Object.values(value as Record<string, unknown>)
                .map((item: unknown) => this.normalizeTextValue(item))
                .filter((item: string) => item.length > 0)
                .join("；");
        }

        return normalizeWhitespace(value);
    }

    private normalizeRawArray(rawValue: unknown): unknown[] {
        if (Array.isArray(rawValue)) {
            return rawValue;
        }

        if (typeof rawValue === "string") {
            return rawValue.split(/[,\n，、;；\s]+/g);
        }

        return [];
    }

    private extractIdLikeValue(value: unknown): string {
        if (value !== null && typeof value === "object") {
            return normalizeWhitespace(this.readRecordValue(this.asRecord(value), ["id", "chunk_id", "chunkId", "excerpt_id", "excerptId"]));
        }

        return normalizeWhitespace(value);
    }

    private readRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(record, key)) {
                return record[key];
            }
        }

        const normalizedKeys: Set<string> = new Set<string>(keys.map((key: string) => key.toLowerCase()));
        for (const [recordKey, value] of Object.entries(record)) {
            if (normalizedKeys.has(recordKey.toLowerCase())) {
                return value;
            }
        }

        return undefined;
    }

    private asRecord(value: unknown): Record<string, unknown> {
        return value !== null && typeof value === "object"
            ? value as Record<string, unknown>
            : {};
    }

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

    private getBatchSize(): number {
        const settings: VaultCoachSettings = this.getSettings();
        return settings.modelProvider === "openai-compatible" ? 6 : 5;
    }

    private truncateSourceText(value: string, maxLength: number): string {
        const normalizedValue: string = normalizeWhitespace(value);
        return normalizedValue.length > maxLength
            ? `${normalizedValue.slice(0, maxLength)}...`
            : normalizedValue;
    }

    private chunkArray<T>(items: T[], size: number): T[][] {
        const batches: T[][] = [];
        for (let index = 0; index < items.length; index += size) {
            batches.push(items.slice(index, index + size));
        }
        return batches;
    }

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
