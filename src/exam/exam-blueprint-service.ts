import { LocalModelClient } from "../model-client";
import type {
    ExamBlueprint,
    ExamBlueprintItem,
    ExamContentProfile,
    IndexedChunk,
    LocalChatMessage,
} from "../types";
import { generateParsedJsonAnswer, normalizeWhitespace } from "./exam-utils";

interface ExamBlueprintPayload {
    title?: unknown;
    requested_question_count?: unknown;
    planned_question_count?: unknown;
    items?: unknown;
}

interface ExamBlueprintItemPayload {
    id?: unknown;
    topic?: unknown;
    learning_objective?: unknown;
    question_type?: unknown;
    difficulty?: unknown;
    source_chunk_ids?: unknown;
}

const QUESTION_TYPES: ExamBlueprintItem["questionType"][] = [
    "explanation",
    "comparison",
    "application",
    "reasoning",
    "process",
];

const DIFFICULTIES: ExamBlueprintItem["difficulty"][] = [
    "basic",
    "intermediate",
    "advanced",
];

export class ExamBlueprintService {
    private readonly client: LocalModelClient;

    constructor(client: LocalModelClient) {
        this.client = client;
    }

    async buildBlueprint(
        scopeLabel: string,
        chunks: IndexedChunk[],
        profiles: ExamContentProfile[],
        requestedQuestionCount: number,
        abortSignal?: AbortSignal,
    ): Promise<ExamBlueprint> {
        const plannedQuestionCount: number = Math.min(
            Math.max(1, Math.floor(requestedQuestionCount)),
            this.estimateContentCapacity(chunks),
        );
        if (plannedQuestionCount <= 0) {
            throw new Error("当前考试范围内没有足够内容生成考试蓝图。");
        }

        try {
            const payload: ExamBlueprintPayload = await this.generateBlueprintWithModel(
                scopeLabel,
                chunks,
                profiles,
                requestedQuestionCount,
                plannedQuestionCount,
                abortSignal,
            );
            const normalizedBlueprint: ExamBlueprint = this.normalizeBlueprintPayload(
                payload,
                scopeLabel,
                chunks,
                requestedQuestionCount,
                plannedQuestionCount,
            );
            if (normalizedBlueprint.items.length > 0) {
                return normalizedBlueprint;
            }
        } catch (error: unknown) {
            if (this.isAbortError(error)) {
                throw error;
            }
            console.warn("[VaultCoach] 考试蓝图模型规划失败，将使用确定性蓝图。", error);
        }

        return this.buildDeterministicBlueprint(scopeLabel, chunks, requestedQuestionCount, plannedQuestionCount);
    }

    private async generateBlueprintWithModel(
        scopeLabel: string,
        chunks: IndexedChunk[],
        profiles: ExamContentProfile[],
        requestedQuestionCount: number,
        plannedQuestionCount: number,
        abortSignal?: AbortSignal,
    ): Promise<ExamBlueprintPayload> {
        const inventoryChunks: IndexedChunk[] = this.selectPlanningChunks(chunks, 32, 18000);
        const messages: LocalChatMessage[] = [
            {
                role: "system",
                content: [
                    "你是 VaultCoach 的考试蓝图规划器。",
                    "你的任务是从给定知识片段中规划测试覆盖范围。",
                    "必须遵守：",
                    "1. 只使用给定 chunk id，不能虚构来源。",
                    "2. 每个蓝图项生成一道题，每项至少绑定一个 source_chunk_ids。",
                    "3. 默认不要重复使用同一个 chunk。",
                    "4. 优先覆盖不同文件和不同主题。",
                    "5. 内容不足时减少 planned_question_count，不能凑题。",
                    "6. 只输出 JSON，不要输出 Markdown、解释或代码块。",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    `考试范围：${scopeLabel}`,
                    `请求题目数：${requestedQuestionCount}`,
                    `容量上限：${plannedQuestionCount}`,
                    "",
                    "内容画像摘要：",
                    this.buildProfileSummary(profiles),
                    "",
                    "可用 chunk 清单：",
                    this.buildChunkInventory(inventoryChunks),
                    "",
                    "请输出 JSON：",
                    this.buildBlueprintSchema(),
                ].join("\n"),
            },
        ];

        return generateParsedJsonAnswer<ExamBlueprintPayload>(
            this.client,
            messages,
            0,
            this.buildBlueprintSchema(),
            "考试蓝图生成",
            abortSignal,
        );
    }

    private normalizeBlueprintPayload(
        payload: ExamBlueprintPayload,
        scopeLabel: string,
        chunks: IndexedChunk[],
        requestedQuestionCount: number,
        maxQuestionCount: number,
    ): ExamBlueprint {
        const chunkById: Map<string, IndexedChunk> = new Map<string, IndexedChunk>(
            chunks.map((chunk: IndexedChunk) => [chunk.id, chunk]),
        );
        const usedChunkIds: Set<string> = new Set<string>();
        const items: ExamBlueprintItem[] = [];
        const payloadItems: ExamBlueprintItemPayload[] = Array.isArray(payload.items)
            ? payload.items.filter((item: unknown): item is ExamBlueprintItemPayload => {
                return item !== null && typeof item === "object";
            })
            : [];

        for (const payloadItem of payloadItems) {
            if (items.length >= maxQuestionCount) {
                break;
            }

            const sourceChunkIds: string[] = this.normalizeSourceChunkIds(payloadItem.source_chunk_ids, chunkById, usedChunkIds);
            if (sourceChunkIds.length === 0) {
                continue;
            }

            for (const chunkId of sourceChunkIds) {
                usedChunkIds.add(chunkId);
            }

            const fallbackChunk: IndexedChunk | undefined = chunkById.get(sourceChunkIds[0] ?? "");
            const topic: string = normalizeWhitespace(payloadItem.topic ?? "")
                || fallbackChunk?.primaryHeading
                || fallbackChunk?.fileName.replace(/\.md$/i, "")
                || `主题 ${items.length + 1}`;
            items.push({
                id: this.normalizeBlueprintItemId(payloadItem.id, items.length + 1),
                topic,
                learningObjective: normalizeWhitespace(payloadItem.learning_objective ?? "")
                    || `考察用户是否理解「${topic}」并能基于来源内容作答。`,
                questionType: this.normalizeQuestionType(payloadItem.question_type, items.length),
                difficulty: this.normalizeDifficulty(payloadItem.difficulty, items.length, maxQuestionCount),
                sourceChunkIds,
            });
        }

        const fallbackBlueprint: ExamBlueprint = this.buildDeterministicBlueprint(scopeLabel, chunks, requestedQuestionCount, maxQuestionCount);
        for (const fallbackItem of fallbackBlueprint.items) {
            if (items.length >= maxQuestionCount) {
                break;
            }

            if (fallbackItem.sourceChunkIds.some((chunkId: string) => usedChunkIds.has(chunkId))) {
                continue;
            }

            items.push({
                ...fallbackItem,
                id: `bp${items.length + 1}`,
            });
            for (const chunkId of fallbackItem.sourceChunkIds) {
                usedChunkIds.add(chunkId);
            }
        }

        return {
            title: normalizeWhitespace(payload.title ?? "") || `${scopeLabel} 测试蓝图`,
            requestedQuestionCount,
            plannedQuestionCount: items.length,
            items,
        };
    }

    private normalizeSourceChunkIds(
        rawValue: unknown,
        chunkById: Map<string, IndexedChunk>,
        usedChunkIds: Set<string>,
    ): string[] {
        if (!Array.isArray(rawValue)) {
            return [];
        }

        const chunkIds: string[] = [];
        for (const value of rawValue) {
            if (typeof value !== "string") {
                continue;
            }

            const chunkId: string = value.trim();
            if (!chunkById.has(chunkId) || usedChunkIds.has(chunkId)) {
                continue;
            }

            chunkIds.push(chunkId);
        }

        return Array.from(new Set(chunkIds)).slice(0, 3);
    }

    private buildDeterministicBlueprint(
        scopeLabel: string,
        chunks: IndexedChunk[],
        requestedQuestionCount: number,
        plannedQuestionCount: number,
    ): ExamBlueprint {
        const selectedChunks: IndexedChunk[] = this.selectPlanningChunks(chunks, plannedQuestionCount, 20000);
        const items: ExamBlueprintItem[] = selectedChunks.slice(0, plannedQuestionCount).map((chunk: IndexedChunk, index: number) => {
            const topic: string = chunk.primaryHeading ?? chunk.headingPath[0] ?? chunk.fileName.replace(/\.md$/i, "");
            return {
                id: `bp${index + 1}`,
                topic,
                learningObjective: `考察用户是否理解「${topic}」并能基于来源内容解释、比较或应用。`,
                questionType: QUESTION_TYPES[index % QUESTION_TYPES.length] ?? "explanation",
                difficulty: DIFFICULTIES[Math.min(DIFFICULTIES.length - 1, Math.floor(index / Math.max(1, Math.ceil(plannedQuestionCount / DIFFICULTIES.length))))] ?? "basic",
                sourceChunkIds: [chunk.id],
            };
        });

        return {
            title: `${scopeLabel} 测试蓝图`,
            requestedQuestionCount,
            plannedQuestionCount: items.length,
            items,
        };
    }

    private selectPlanningChunks(chunks: IndexedChunk[], maxChunks: number, maxCharacters: number): IndexedChunk[] {
        const chunksByFilePath: Map<string, IndexedChunk[]> = new Map<string, IndexedChunk[]>();
        for (const chunk of chunks) {
            const fileChunks: IndexedChunk[] = chunksByFilePath.get(chunk.filePath) ?? [];
            fileChunks.push(chunk);
            chunksByFilePath.set(chunk.filePath, fileChunks);
        }

        const filePaths: string[] = Array.from(chunksByFilePath.keys()).sort((leftPath: string, rightPath: string) => {
            return leftPath.localeCompare(rightPath);
        });
        const selectedChunks: IndexedChunk[] = [];
        let usedCharacters = 0;
        let round = 0;

        while (selectedChunks.length < maxChunks) {
            let addedInRound = false;
            for (const filePath of filePaths) {
                const fileChunks: IndexedChunk[] | undefined = chunksByFilePath.get(filePath);
                const chunk: IndexedChunk | undefined = fileChunks?.[round];
                if (!chunk) {
                    continue;
                }

                const nextSize: number = chunk.text.length + chunk.filePath.length + 120;
                if (selectedChunks.length > 0 && usedCharacters + nextSize > maxCharacters) {
                    return selectedChunks;
                }

                selectedChunks.push(chunk);
                usedCharacters += nextSize;
                addedInRound = true;
                if (selectedChunks.length >= maxChunks) {
                    break;
                }
            }

            if (!addedInRound) {
                break;
            }
            round += 1;
        }

        return selectedChunks;
    }

    private estimateContentCapacity(chunks: IndexedChunk[]): number {
        if (chunks.length === 0) {
            return 0;
        }

        const fileCount: number = new Set(chunks.map((chunk: IndexedChunk) => chunk.filePath)).size;
        return Math.min(10, Math.max(1, Math.ceil(chunks.length / 2)), Math.max(1, fileCount * 3));
    }

    private buildProfileSummary(profiles: ExamContentProfile[]): string {
        const includedProfiles: ExamContentProfile[] = profiles.filter((profile: ExamContentProfile) => profile.decision !== "exclude");
        if (includedProfiles.length === 0) {
            return "（无画像）";
        }

        return includedProfiles.map((profile: ExamContentProfile) => {
            return [
                `FILE: ${profile.filePath}`,
                `DECISION: ${profile.decision}`,
                `TOPICS: ${profile.topics.join(", ") || "unknown"}`,
                `CAPACITY: ${profile.estimatedQuestionCapacity}`,
            ].join("\n");
        }).join("\n\n");
    }

    private buildChunkInventory(chunks: IndexedChunk[]): string {
        return chunks.map((chunk: IndexedChunk, index: number) => {
            return [
                `CHUNK_INDEX: ${index + 1}`,
                `CHUNK_ID: ${chunk.id}`,
                `SOURCE_PATH: ${chunk.filePath}`,
                `HEADING: ${chunk.headingPath.length > 0 ? chunk.headingPath.join(" > ") : "（无标题）"}`,
                "TEXT:",
                chunk.text.slice(0, 700),
            ].join("\n");
        }).join("\n\n");
    }

    private buildBlueprintSchema(): string {
        return [
            "{",
            "  \"title\": \"测试蓝图标题\",",
            "  \"requested_question_count\": 8,",
            "  \"planned_question_count\": 6,",
            "  \"items\": [",
            "    {",
            "      \"id\": \"bp1\",",
            "      \"topic\": \"知识主题\",",
            "      \"learning_objective\": \"学习目标\",",
            "      \"question_type\": \"explanation | comparison | application | reasoning | process\",",
            "      \"difficulty\": \"basic | intermediate | advanced\",",
            "      \"source_chunk_ids\": [\"真实 chunk id\"]",
            "    }",
            "  ]",
            "}",
        ].join("\n");
    }

    private normalizeBlueprintItemId(value: unknown, fallbackIndex: number): string {
        const normalizedValue: string = normalizeWhitespace(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        return normalizedValue.length > 0 ? normalizedValue : `bp${fallbackIndex}`;
    }

    private normalizeQuestionType(value: unknown, index: number): ExamBlueprintItem["questionType"] {
        return QUESTION_TYPES.includes(value as ExamBlueprintItem["questionType"])
            ? value as ExamBlueprintItem["questionType"]
            : QUESTION_TYPES[index % QUESTION_TYPES.length] ?? "explanation";
    }

    private normalizeDifficulty(value: unknown, index: number, total: number): ExamBlueprintItem["difficulty"] {
        if (DIFFICULTIES.includes(value as ExamBlueprintItem["difficulty"])) {
            return value as ExamBlueprintItem["difficulty"];
        }

        return DIFFICULTIES[Math.min(DIFFICULTIES.length - 1, Math.floor(index / Math.max(1, Math.ceil(total / DIFFICULTIES.length))))] ?? "basic";
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
