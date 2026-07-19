import { LocalModelClient } from "../model-client";
import type {
    ExamContentProfile,
    ExamContentProfileCacheKey,
    ExamExclusionReason,
    ExamFileOption,
} from "../domain/exam/exam-types";
import type { IndexedChunk } from "../domain/documents/document-types";
import type { DocumentIndexReader } from "../domain/documents/document-index-reader";
import type { LocalChatMessage } from "../domain/model/model-types";
import type { VaultCoachSettings } from "../app/config/settings-types";
import { clampNumber, generateParsedJsonAnswer, headingPathKey, normalizeHeadingPath, normalizeWhitespace, throwIfAborted } from "./exam-utils";
import { ExamProfileStore } from "./exam-profile-store";

/**
 * 考试内容画像模块。
 *
 * 负责判断文件或章节是否适合用于考试出题，并输出 include / partial / exclude 决策。
 * 该模块结合确定性规则、模型分类和本地缓存，降低低质量题目和无意义出题范围。
 */

export const EXAM_CONTENT_PROFILE_PROMPT_VERSION = "exam-content-profile-v1";

/**
 * 模型返回的文件级画像结构。
 */
interface ExamContentProfilePayload {
    decision?: unknown;
    confidence?: unknown;
    reason_codes?: unknown;
    eligible_heading_paths?: unknown;
    excluded_heading_paths?: unknown;
    topics?: unknown;
    estimated_question_capacity?: unknown;
}

/**
 * 模型返回的 section 级画像结构。
 */
interface ExamSectionProfilePayload extends ExamContentProfilePayload {
    eligible_section_indexes?: unknown;
    excluded_section_indexes?: unknown;
}

/**
 * 批量画像结果。
 */
interface ExamProfileBatchResult {
    profiles: ExamContentProfile[];
    cacheHits: number;
    cacheMisses: number;
}

/**
 * 文件内容统计特征。
 */
interface ExamContentStats {
    textLength: number;
    checkboxCount: number;
    linkCount: number;
    codeBlockCharacters: number;
    paragraphCount: number;
}

/**
 * 按标题聚合后的考试 section。
 */
interface ExamSectionGroup {
    index: number;
    headingPath: string[];
    chunks: IndexedChunk[];
    text: string;
}

const VALID_REASON_CODES: Set<ExamExclusionReason> = new Set<ExamExclusionReason>([
    "task-list",
    "temporary-log",
    "empty-or-stub",
    "link-index",
    "raw-output",
    "duplicated-content",
    "insufficient-context",
    "not-answerable",
    "low-learning-value",
    "mixed-content",
    "user-rule",
    "other",
]);

/**
 * 考试内容画像器。
 */
export class ExamContentProfiler {
    private readonly documentIndex: DocumentIndexReader;
    private readonly client: LocalModelClient;
    private readonly store: ExamProfileStore;
    private readonly getSettings: () => VaultCoachSettings;

    constructor(
        documentIndex: DocumentIndexReader,
        client: LocalModelClient,
        store: ExamProfileStore,
        getSettings: () => VaultCoachSettings,
    ) {
        this.documentIndex = documentIndex;
        this.client = client;
        this.store = store;
        this.getSettings = getSettings;
    }

    /**
     * 批量生成文件画像。
     *
     * 优先读取缓存；缓存未命中时才读取内容并调用规则/模型分析。
     */
    async profileFiles(
        fileOptions: ExamFileOption[],
        options: {
            forceRefresh?: boolean;
            abortSignal?: AbortSignal;
            onProgress?: (current: number, total: number) => void;
        } = {},
    ): Promise<ExamProfileBatchResult> {
        const profiles: ExamContentProfile[] = [];
        let cacheHits = 0;
        let cacheMisses = 0;

        for (let index = 0; index < fileOptions.length; index += 1) {
            throwIfAborted(options.abortSignal);
            const fileOption: ExamFileOption | undefined = fileOptions[index];
            if (!fileOption) {
                continue;
            }

            options.onProgress?.(index + 1, fileOptions.length);
            const contentHash: string | null = this.documentIndex.getFileRecord(fileOption.filePath)?.contentHash ?? null;
            if (!contentHash) {
                profiles.push(this.createProfile(fileOption.filePath, "exclude", 1, ["empty-or-stub"], [], [], [], 0));
                continue;
            }

            const cacheKey: ExamContentProfileCacheKey = this.buildCacheKey(fileOption.filePath, contentHash);
            if (!options.forceRefresh) {
                const cachedProfile: ExamContentProfile | null = await this.store.getProfile(cacheKey);
                if (cachedProfile) {
                    profiles.push(this.normalizeCachedProfile(cachedProfile, fileOption.filePath, this.documentIndex.getChunksByFilePath(fileOption.filePath)));
                    cacheHits += 1;
                    continue;
                }
            }

            cacheMisses += 1;
            const profile: ExamContentProfile = await this.profileFile(fileOption, options.abortSignal);
            profiles.push(profile);
            await this.store.saveProfile(cacheKey, profile);
        }

        return {
            profiles,
            cacheHits,
            cacheMisses,
        };
    }

    /**
     * 构造画像缓存键。
     */
    private buildCacheKey(filePath: string, contentHash: string): ExamContentProfileCacheKey {
        const settings: VaultCoachSettings = this.getSettings();
        return {
            filePath,
            contentHash,
            modelProvider: settings.modelProvider,
            modelName: this.getActiveChatModel(settings),
            promptVersion: EXAM_CONTENT_PROFILE_PROMPT_VERSION,
        };
    }

    /**
     * 生成单个文件画像。
     */
    private async profileFile(fileOption: ExamFileOption, abortSignal?: AbortSignal): Promise<ExamContentProfile> {
        const chunks: IndexedChunk[] = this.documentIndex.getChunksByFilePath(fileOption.filePath);
        const content: string = await this.documentIndex.readDocumentText(fileOption.filePath) ?? "";
        const deterministicProfile: ExamContentProfile | null = this.buildDeterministicProfile(fileOption.filePath, content, chunks);
        if (deterministicProfile) {
            return deterministicProfile;
        }

        const settings: VaultCoachSettings = this.getSettings();
        if (this.getActiveChatModel(settings).length === 0) {
            return this.createProfile(
                fileOption.filePath,
                "include",
                0.45,
                [],
                [],
                [],
                this.inferTopics(fileOption.fileName, chunks),
                this.estimateQuestionCapacity(chunks.length),
            );
        }

        const filePayload: ExamContentProfilePayload = await this.classifyFileWithModel(fileOption, content, chunks, abortSignal);
        let profile: ExamContentProfile = this.normalizeProfilePayload(fileOption.filePath, filePayload, chunks);
        if (profile.decision === "partial") {
            profile = await this.refinePartialProfile(fileOption.filePath, profile, chunks, abortSignal);
        }

        if (profile.decision === "partial" && profile.eligibleHeadingPaths.length === 0) {
            return {
                ...profile,
                decision: "exclude",
                reasonCodes: this.mergeReasonCodes(profile.reasonCodes, ["insufficient-context"]),
                estimatedQuestionCapacity: 0,
            };
        }

        return profile;
    }

    /**
     * 使用确定性规则快速排除明显不适合出题的内容。
     */
    private buildDeterministicProfile(filePath: string, content: string, chunks: IndexedChunk[]): ExamContentProfile | null {
        const cleanedText: string = this.cleanMarkdownText(content.length > 0 ? content : chunks.map((chunk: IndexedChunk) => chunk.text).join("\n\n"));
        if (chunks.length === 0 || cleanedText.length < 80) {
            return this.createProfile(filePath, "exclude", 1, ["empty-or-stub"], [], [], [], 0);
        }

        const rawLines: string[] = (content.length > 0 ? content : chunks.map((chunk: IndexedChunk) => chunk.text).join("\n\n"))
            .split(/\r?\n/g)
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0);
        const contentLines: string[] = cleanedText
            .split(/\r?\n/g)
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0);
        const checkboxLineCount: number = rawLines.filter((line: string) => /^[-*+]\s+\[[ xX]\]/.test(line)).length;
        const linkOnlyLineCount: number = rawLines.filter((line: string) => {
            const withoutLinks: string = line
                .replace(/\[\[[^\]]+\]\]/g, "")
                .replace(/\[[^\]]+\]\([^)]+\)/g, "")
                .replace(/^[-*+]\s+/, "")
                .trim();
            return withoutLinks.length <= 8 && (/\[\[[^\]]+\]\]/.test(line) || /\[[^\]]+\]\([^)]+\)/.test(line));
        }).length;
        const substantialParagraphCount: number = contentLines.filter((line: string) => {
            return line.length >= 24
                && !/^[-*+]\s+\[[ xX]\]/.test(line)
                && !/^[-*+]\s+\S+$/.test(line)
                && !/^#{1,6}\s+/.test(line);
        }).length;
        const commandOrLogLineCount: number = rawLines.filter((line: string) => {
            return /^(\$|>|npm |pnpm |yarn |cargo |go |python |Traceback|Error:|at\s+\S+\()/.test(line);
        }).length;

        if (checkboxLineCount >= Math.max(3, Math.ceil(contentLines.length * 0.6)) && substantialParagraphCount <= 1) {
            return this.createProfile(filePath, "exclude", 0.95, ["task-list"], [], [], [], 0);
        }

        if (linkOnlyLineCount >= Math.max(3, Math.ceil(contentLines.length * 0.6)) && substantialParagraphCount <= 1) {
            return this.createProfile(filePath, "exclude", 0.95, ["link-index"], [], [], [], 0);
        }

        if (commandOrLogLineCount >= Math.max(5, Math.ceil(rawLines.length * 0.6)) && substantialParagraphCount <= 1) {
            return this.createProfile(filePath, "exclude", 0.95, ["raw-output"], [], [], [], 0);
        }

        return null;
    }

    /**
     * 调用模型进行文件级内容分类。
     */
    private async classifyFileWithModel(
        fileOption: ExamFileOption,
        content: string,
        chunks: IndexedChunk[],
        abortSignal?: AbortSignal,
    ): Promise<ExamContentProfilePayload> {
        const stats: ExamContentStats = this.computeContentStats(content, chunks);
        const messages: LocalChatMessage[] = [
            {
                role: "system",
                content: [
                    "你是 VaultCoach 的考试语料筛选器。",
                    "你的任务是判断一份 Obsidian Markdown 是否适合用于出题。",
                    "只输出 JSON，不要输出 Markdown、解释或代码块。",
                    "decision 只能是 include、partial、exclude。",
                    "reason_codes 只能使用：task-list, temporary-log, empty-or-stub, link-index, raw-output, duplicated-content, insufficient-context, not-answerable, low-learning-value, mixed-content, user-rule, other。",
                    "partial 只用于同一文件中同时存在可考试知识和 TODO、日志、链接索引、草稿等低价值内容的情况。",
                    "不要保存或输出推理过程。",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    `文件路径：${fileOption.filePath}`,
                    `文件名：${fileOption.fileName}`,
                    `chunk 数量：${chunks.length}`,
                    `正文长度：${stats.textLength}`,
                    `checkbox 数：${stats.checkboxCount}`,
                    `链接数：${stats.linkCount}`,
                    `代码块字符数：${stats.codeBlockCharacters}`,
                    `正文段落数：${stats.paragraphCount}`,
                    "",
                    "标题目录：",
                    this.buildHeadingCatalog(chunks),
                    "",
                    "代表性内容：",
                    this.buildRepresentativeContent(content, chunks),
                    "",
                    "请输出 JSON：",
                    this.buildProfileSchema(),
                ].join("\n"),
            },
        ];

        return generateParsedJsonAnswer<ExamContentProfilePayload>(
            this.client,
            messages,
            0,
            this.buildProfileSchema(),
            "考试内容文件级筛选",
            abortSignal,
        );
    }

    /**
     * 对 partial 文件继续做 section 级细化，找出真正可出题的标题路径。
     */
    private async refinePartialProfile(
        filePath: string,
        profile: ExamContentProfile,
        chunks: IndexedChunk[],
        abortSignal?: AbortSignal,
    ): Promise<ExamContentProfile> {
        const sections: ExamSectionGroup[] = this.groupChunksByHeading(chunks);
        if (sections.length === 0) {
            return profile;
        }

        const messages: LocalChatMessage[] = [
            {
                role: "system",
                content: [
                    "你是 VaultCoach 的考试语料 section 筛选器。",
                    "文件级判断已经是 partial。你的任务是从 heading-aware sections 中选择适合出题的章节。",
                    "适合出题的 section 应包含概念、原理、步骤、比较、决策理由、案例解释或可回答的知识点。",
                    "排除 TODO、任务状态、链接索引、临时日志、原始输出、空模板和不可回答片段。",
                    "只输出 JSON，不要输出 Markdown、解释或代码块。",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    `文件路径：${filePath}`,
                    `文件级原因：${profile.reasonCodes.join(", ") || "none"}`,
                    "",
                    "Sections：",
                    sections.map((section: ExamSectionGroup) => {
                        return [
                            `SECTION_INDEX: ${section.index}`,
                            `HEADING_PATH: ${section.headingPath.length > 0 ? section.headingPath.join(" > ") : "（无标题）"}`,
                            "TEXT:",
                            section.text.slice(0, 1200),
                        ].join("\n");
                    }).join("\n\n"),
                    "",
                    "请输出 JSON：",
                    this.buildSectionProfileSchema(),
                ].join("\n"),
            },
        ];

        const payload: ExamSectionProfilePayload = await generateParsedJsonAnswer<ExamSectionProfilePayload>(
            this.client,
            messages,
            0,
            this.buildSectionProfileSchema(),
            "考试内容 section 级筛选",
            abortSignal,
        );
        const normalizedProfile: ExamContentProfile = this.normalizeProfilePayload(filePath, payload, chunks, profile);
        const eligibleHeadingPathsFromIndexes: string[][] = this.resolveSectionIndexes(payload.eligible_section_indexes, sections);
        const excludedHeadingPathsFromIndexes: string[][] = this.resolveSectionIndexes(payload.excluded_section_indexes, sections);

        return {
            ...normalizedProfile,
            decision: "partial",
            eligibleHeadingPaths: eligibleHeadingPathsFromIndexes.length > 0
                ? eligibleHeadingPathsFromIndexes
                : normalizedProfile.eligibleHeadingPaths,
            excludedHeadingPaths: excludedHeadingPathsFromIndexes.length > 0
                ? excludedHeadingPathsFromIndexes
                : normalizedProfile.excludedHeadingPaths,
            reasonCodes: this.mergeReasonCodes(profile.reasonCodes, normalizedProfile.reasonCodes.length > 0 ? normalizedProfile.reasonCodes : ["mixed-content"]),
        };
    }

    /**
     * 校验并归一化模型画像输出。
     */
    private normalizeProfilePayload(
        filePath: string,
        payload: ExamContentProfilePayload,
        chunks: IndexedChunk[],
        fallback?: ExamContentProfile,
    ): ExamContentProfile {
        const decision: ExamContentProfile["decision"] = payload.decision === "partial" || payload.decision === "exclude"
            ? payload.decision
            : "include";
        const reasonCodes: ExamExclusionReason[] = this.normalizeReasonCodes(payload.reason_codes);
        const knownHeadingKeys: Set<string> = new Set<string>(this.groupChunksByHeading(chunks).map((section: ExamSectionGroup) => headingPathKey(section.headingPath)));
        const eligibleHeadingPaths: string[][] = this.normalizeHeadingPaths(payload.eligible_heading_paths, knownHeadingKeys);
        const excludedHeadingPaths: string[][] = this.normalizeHeadingPaths(payload.excluded_heading_paths, knownHeadingKeys);
        const topics: string[] = this.normalizeStringArray(payload.topics);
        const capacity: number = typeof payload.estimated_question_capacity === "number"
            ? Math.round(clampNumber(payload.estimated_question_capacity, 0, 10))
            : this.estimateQuestionCapacity(decision === "exclude" ? 0 : chunks.length);

        return {
            filePath,
            decision,
            confidence: clampNumber(payload.confidence ?? fallback?.confidence ?? 0.6, 0, 1),
            reasonCodes: reasonCodes.length > 0 ? reasonCodes : fallback?.reasonCodes ?? [],
            eligibleHeadingPaths,
            excludedHeadingPaths,
            topics: topics.length > 0 ? topics : fallback?.topics ?? this.inferTopics(filePath, chunks),
            estimatedQuestionCapacity: decision === "exclude" ? 0 : capacity,
        };
    }

    /**
     * 归一化缓存中的画像，兼容旧版本或损坏字段。
     */
    private normalizeCachedProfile(
        profile: ExamContentProfile,
        fallbackFilePath: string,
        chunks: IndexedChunk[],
    ): ExamContentProfile {
        const rawProfile: Record<string, unknown> = profile as unknown as Record<string, unknown>;
        const decisionValue: unknown = rawProfile["decision"];
        const decision: ExamContentProfile["decision"] = decisionValue === "partial" || decisionValue === "exclude"
            ? decisionValue
            : "include";
        const knownHeadingKeys: Set<string> = new Set<string>(this.groupChunksByHeading(chunks).map((section: ExamSectionGroup) => headingPathKey(section.headingPath)));
        const capacity: number = Math.round(clampNumber(
            rawProfile["estimatedQuestionCapacity"],
            0,
            10,
        ));

        return {
            filePath: normalizeWhitespace(rawProfile["filePath"]) || fallbackFilePath,
            decision,
            confidence: clampNumber(rawProfile["confidence"], 0, 1),
            reasonCodes: this.normalizeReasonCodes(rawProfile["reasonCodes"]),
            eligibleHeadingPaths: this.normalizeHeadingPaths(rawProfile["eligibleHeadingPaths"], knownHeadingKeys),
            excludedHeadingPaths: this.normalizeHeadingPaths(rawProfile["excludedHeadingPaths"], knownHeadingKeys),
            topics: this.normalizeStringArray(rawProfile["topics"]),
            estimatedQuestionCapacity: decision === "exclude" ? 0 : capacity,
        };
    }

    /**
     * 创建画像对象。
     */
    private createProfile(
        filePath: string,
        decision: ExamContentProfile["decision"],
        confidence: number,
        reasonCodes: ExamExclusionReason[],
        eligibleHeadingPaths: string[][],
        excludedHeadingPaths: string[][],
        topics: string[],
        estimatedQuestionCapacity: number,
    ): ExamContentProfile {
        return {
            filePath,
            decision,
            confidence,
            reasonCodes,
            eligibleHeadingPaths,
            excludedHeadingPaths,
            topics,
            estimatedQuestionCapacity,
        };
    }

    /**
     * 归一化排除原因，只保留枚举内的值。
     */
    private normalizeReasonCodes(rawValue: unknown): ExamExclusionReason[] {
        if (!Array.isArray(rawValue)) {
            return [];
        }

        const reasonCodes: ExamExclusionReason[] = [];
        for (const value of rawValue) {
            if (typeof value !== "string") {
                continue;
            }

            const normalizedValue: string = value.trim();
            reasonCodes.push(VALID_REASON_CODES.has(normalizedValue as ExamExclusionReason)
                ? normalizedValue as ExamExclusionReason
                : "other");
        }

        return Array.from(new Set(reasonCodes));
    }

    /**
     * 归一化并校验标题路径。
     */
    private normalizeHeadingPaths(rawValue: unknown, knownHeadingKeys: Set<string>): string[][] {
        if (!Array.isArray(rawValue)) {
            return [];
        }

        const headingPaths: string[][] = [];
        for (const value of rawValue) {
            const headingPath: string[] = normalizeHeadingPath(value);
            if (headingPath.length === 0) {
                continue;
            }

            if (knownHeadingKeys.size > 0 && !knownHeadingKeys.has(headingPathKey(headingPath))) {
                continue;
            }

            headingPaths.push(headingPath);
        }

        const seenKeys: Set<string> = new Set<string>();
        return headingPaths.filter((headingPath: string[]) => {
            const key: string = headingPathKey(headingPath);
            if (seenKeys.has(key)) {
                return false;
            }
            seenKeys.add(key);
            return true;
        });
    }

    /**
     * 将模型返回的 section index 映射回标题路径。
     */
    private resolveSectionIndexes(rawValue: unknown, sections: ExamSectionGroup[]): string[][] {
        if (!Array.isArray(rawValue)) {
            return [];
        }

        const headingPaths: string[][] = [];
        for (const value of rawValue) {
            const sectionIndex: number = typeof value === "number"
                ? value
                : (typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN);
            if (!Number.isFinite(sectionIndex)) {
                continue;
            }

            const section: ExamSectionGroup | undefined = sections.find((item: ExamSectionGroup) => item.index === sectionIndex);
            if (section) {
                headingPaths.push(section.headingPath);
            }
        }

        return headingPaths;
    }

    /**
     * 归一化主题数组，并限制返回数量。
     */
    private normalizeStringArray(rawValue: unknown): string[] {
        if (!Array.isArray(rawValue)) {
            return [];
        }

        return Array.from(new Set(
            rawValue
                .filter((value: unknown): value is string => typeof value === "string")
                .map((value: string) => normalizeWhitespace(value))
                .filter((value: string) => value.length > 0),
        )).slice(0, 8);
    }

    /**
     * 合并排除原因并去重。
     */
    private mergeReasonCodes(left: ExamExclusionReason[], right: ExamExclusionReason[]): ExamExclusionReason[] {
        return Array.from(new Set([...left, ...right]));
    }

    /**
     * 从标题路径和文件名推断主题。
     */
    private inferTopics(fileNameOrPath: string, chunks: IndexedChunk[]): string[] {
        const topics: string[] = [];
        for (const chunk of chunks) {
            const topic: string = chunk.primaryHeading ?? chunk.headingPath[0] ?? chunk.fileName.replace(/\.md$/i, "");
            if (topic.length > 0) {
                topics.push(topic);
            }
        }

        if (topics.length === 0) {
            topics.push(fileNameOrPath.replace(/\.md$/i, "").split("/").pop() ?? fileNameOrPath);
        }

        return Array.from(new Set(topics)).slice(0, 8);
    }

    /**
     * 根据 chunk 数估算可支持的题量。
     */
    private estimateQuestionCapacity(chunkCount: number): number {
        if (chunkCount <= 0) {
            return 0;
        }

        return Math.max(1, Math.min(10, Math.ceil(chunkCount / 2)));
    }

    /**
     * 计算模型分类所需的文件统计特征。
     */
    private computeContentStats(content: string, chunks: IndexedChunk[]): ExamContentStats {
        const sourceText: string = content.length > 0 ? content : chunks.map((chunk: IndexedChunk) => chunk.text).join("\n\n");
        const cleanedText: string = this.cleanMarkdownText(sourceText);
        const codeBlockMatches: RegExpMatchArray | null = sourceText.match(/```[\s\S]*?```|~~~[\s\S]*?~~~/g);
        const codeBlocks: string[] = codeBlockMatches ? Array.from(codeBlockMatches) : [];
        const codeBlockCharacters: number = codeBlocks.reduce((sum: number, block: string) => sum + block.length, 0);
        const linkMatches: RegExpMatchArray | null = sourceText.match(/\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)/g);
        const checkboxMatches: RegExpMatchArray | null = sourceText.match(/^[-*+]\s+\[[ xX]\]/gm);
        const paragraphCount: number = cleanedText
            .split(/\n\s*\n|\r?\n/g)
            .map((paragraph: string) => paragraph.trim())
            .filter((paragraph: string) => paragraph.length >= 24).length;

        return {
            textLength: cleanedText.length,
            checkboxCount: checkboxMatches?.length ?? 0,
            linkCount: linkMatches?.length ?? 0,
            codeBlockCharacters,
            paragraphCount,
        };
    }

    /**
     * 构造标题目录，供模型判断 section 分布。
     */
    private buildHeadingCatalog(chunks: IndexedChunk[]): string {
        const headingPaths: string[] = this.groupChunksByHeading(chunks).map((section: ExamSectionGroup) => {
            return section.headingPath.length > 0 ? section.headingPath.join(" > ") : "（无标题）";
        });

        return headingPaths.length > 0 ? headingPaths.join("\n") : "（无标题）";
    }

    /**
     * 构造代表性内容样本，避免把整篇长文直接塞进 prompt。
     */
    private buildRepresentativeContent(content: string, chunks: IndexedChunk[]): string {
        const sections: ExamSectionGroup[] = this.groupChunksByHeading(chunks);
        const samples: string[] = [];
        if (content.length > 0) {
            const frontmatter: string = this.extractFrontmatter(content);
            if (frontmatter.length > 0) {
                samples.push(`FRONTMATTER:\n${frontmatter.slice(0, 1200)}`);
            }
        }

        const maxSamples = Math.min(4, sections.length);
        for (let index = 0; index < maxSamples; index += 1) {
            const sampleIndex: number = maxSamples === 1
                ? 0
                : Math.floor(index * (sections.length - 1) / Math.max(1, maxSamples - 1));
            const section: ExamSectionGroup | undefined = sections[sampleIndex];
            if (!section) {
                continue;
            }

            samples.push([
                `HEADING_PATH: ${section.headingPath.length > 0 ? section.headingPath.join(" > ") : "（无标题）"}`,
                section.text.slice(0, 1000),
            ].join("\n"));
        }

        return samples.join("\n\n---\n\n") || "（无代表性内容）";
    }

    /**
     * 按标题路径聚合 chunk。
     */
    private groupChunksByHeading(chunks: IndexedChunk[]): ExamSectionGroup[] {
        const sectionsByKey: Map<string, ExamSectionGroup> = new Map<string, ExamSectionGroup>();
        for (const chunk of chunks) {
            const key: string = headingPathKey(chunk.headingPath);
            const section: ExamSectionGroup = sectionsByKey.get(key) ?? {
                index: sectionsByKey.size + 1,
                headingPath: [...chunk.headingPath],
                chunks: [],
                text: "",
            };
            section.chunks.push(chunk);
            section.text = section.chunks.map((item: IndexedChunk) => item.text).join("\n\n");
            sectionsByKey.set(key, section);
        }

        return Array.from(sectionsByKey.values());
    }

    /**
     * 清理 Markdown 语法，得到更适合统计质量的纯文本。
     */
    private cleanMarkdownText(markdown: string): string {
        return markdown
            .replace(/^---[\s\S]*?---\s*/m, "")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/~~~[\s\S]*?~~~/g, "")
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/^#{1,6}\s+/gm, "")
            .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
            .replace(/[>`*_~#-]/g, " ")
            .replace(/[ \t]+/g, " ")
            .trim();
    }

    /**
     * 提取 frontmatter，用作内容判断的辅助样本。
     */
    private extractFrontmatter(content: string): string {
        const match: RegExpExecArray | null = /^---\s*([\s\S]*?)\s*---/.exec(content);
        return match?.[1]?.trim() ?? "";
    }

    /**
     * 文件级画像 JSON schema 文本。
     */
    private buildProfileSchema(): string {
        return [
            "{",
            "  \"decision\": \"include | partial | exclude\",",
            "  \"confidence\": 0.8,",
            "  \"reason_codes\": [\"mixed-content\"],",
            "  \"eligible_heading_paths\": [[\"Heading\", \"Subheading\"]],",
            "  \"excluded_heading_paths\": [[\"TODO\"]],",
            "  \"topics\": [\"核心主题\"],",
            "  \"estimated_question_capacity\": 3",
            "}",
        ].join("\n");
    }

    /**
     * section 级画像 JSON schema 文本。
     */
    private buildSectionProfileSchema(): string {
        return [
            "{",
            "  \"decision\": \"partial\",",
            "  \"confidence\": 0.8,",
            "  \"reason_codes\": [\"mixed-content\"],",
            "  \"eligible_section_indexes\": [1, 3],",
            "  \"excluded_section_indexes\": [2],",
            "  \"eligible_heading_paths\": [[\"Heading\", \"Subheading\"]],",
            "  \"excluded_heading_paths\": [[\"TODO\"]],",
            "  \"topics\": [\"核心主题\"],",
            "  \"estimated_question_capacity\": 2",
            "}",
        ].join("\n");
    }

    /**
     * 获取当前聊天模型名称，用于缓存隔离。
     */
    private getActiveChatModel(settings: VaultCoachSettings): string {
        return settings.modelProvider === "openai-compatible"
            ? settings.cloudChatModel.trim()
            : settings.chatModel.trim();
    }
}
