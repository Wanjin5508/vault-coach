import { describe, expect, it, vi } from "vitest";
import { EXAM_QUESTION_GENERATION_PROMPT_VERSION, ExamQuestionGenerator } from "../src/exam/exam-question-generator";
import { ExamQuestionValidator } from "../src/exam/exam-question-validator";
import type { VaultCoachSettings } from "../src/app/config/settings-types";
import type { ExamBlueprint } from "../src/domain/exam/exam-types";
import type { IndexedChunk } from "../src/domain/documents/document-types";
import { LocalModelClient } from "../src/model-client";

function createBlueprint(topic = "  Retrieval   Strategy "): ExamBlueprint {
    return {
        title: "检索策略测试",
        requestedQuestionCount: 1,
        plannedQuestionCount: 1,
        items: [{
            id: "bp-search",
            topic,
            learningObjective: "理解检索策略的组成和适用条件",
            questionType: "reasoning",
            difficulty: "advanced",
            sourceChunkIds: ["chunk-1", "chunk-2"],
        }],
    };
}

function createSimpleBlueprint(): ExamBlueprint {
    return {
        ...createBlueprint(),
        items: [{
            ...createBlueprint().items[0]!,
            answerForm: "single-choice",
        }],
    };
}

function createChunks(): IndexedChunk[] {
    return [
        {
            id: "chunk-1",
            documentId: "markdown:notes/retrieval.md",
            documentType: "markdown",
            filePath: "notes/retrieval.md",
            fileName: "retrieval.md",
            headingPath: ["检索策略"],
            primaryHeading: "检索策略",
            text: "关键词检索用于精确匹配，向量检索用于语义召回。",
            searchableText: "关键词检索用于精确匹配，向量检索用于语义召回。",
            locator: { type: "markdown", filePath: "notes/retrieval.md", heading: "检索策略" },
            contentKind: "native-text",
        },
        {
            id: "chunk-2",
            documentId: "markdown:notes/reranking.md",
            documentType: "markdown",
            filePath: "notes/reranking.md",
            fileName: "reranking.md",
            headingPath: ["重排"],
            primaryHeading: "重排",
            text: "重排用于提升最终上下文的相关性。",
            searchableText: "重排用于提升最终上下文的相关性。",
            locator: { type: "markdown", filePath: "notes/reranking.md", heading: "重排" },
            contentKind: "native-text",
        },
    ];
}

function createSettings(provider: "ollama" | "openai-compatible" = "ollama"): VaultCoachSettings {
    return {
        modelProvider: provider,
        chatModel: "local-exam-model",
        cloudChatModel: "cloud-exam-model",
    } as VaultCoachSettings;
}

function createGenerator(response: string, settings = createSettings()): ExamQuestionGenerator {
    const client = new LocalModelClient(() => settings, () => null);
    vi.spyOn(client, "generateJsonAnswer").mockResolvedValue(response);
    return new ExamQuestionGenerator(client, new ExamQuestionValidator(), () => settings, () => 1700000000000);
}

describe("ExamQuestionGenerator provenance", () => {
    it("preserves validated candidate provenance and model metadata on generated questions", async () => {
        const generator = createGenerator(JSON.stringify({
            questions: [{
                blueprint_item_id: "bp-search",
                question: "为什么关键词检索、向量检索和重排要组合使用以提升检索质量？",
                reference_answer: "关键词检索提供精确匹配，向量检索补足语义召回，重排进一步提升最终上下文的相关性。",
                rubric: "本题按 100 分制评分；准确说明三种机制的作用、关系和组合原因。",
                source_chunk_ids: ["chunk-2", "chunk-1", "chunk-2"],
                evidence_excerpt_ids: ["E2", "E1", "E2"],
            }],
        }));

        const result = await generator.generateQuestions(createBlueprint(), createChunks());

        expect(result.questions).toEqual([{
            id: "q1",
            blueprintItemId: "bp-search",
            question: "为什么关键词检索、向量检索和重排要组合使用以提升检索质量？",
            referenceAnswer: "关键词检索提供精确匹配，向量检索补足语义召回，重排进一步提升最终上下文的相关性。",
            rubric: "本题按 100 分制评分；准确说明三种机制的作用、关系和组合原因。",
            questionType: "reasoning",
            difficulty: "advanced",
            sourceChunkIds: ["chunk-2", "chunk-1"],
            evidenceExcerptIds: ["E2", "E1"],
            sourcePaths: ["notes/reranking.md", "notes/retrieval.md"],
            conceptIds: ["exam-topic:18:4227dc00"],
            generationMetadata: {
                modelProvider: "ollama",
                modelName: "local-exam-model",
                promptVersion: EXAM_QUESTION_GENERATION_PROMPT_VERSION,
                generatedAt: 1700000000000,
            },
        }]);
    });

    it("keeps the same provenance contract for deterministic fallback questions", async () => {
        const generator = createGenerator(JSON.stringify({ questions: [] }), createSettings("openai-compatible"));

        const result = await generator.generateQuestions(createBlueprint("Retrieval Strategy"), createChunks());

        expect(result.questions).toMatchObject([{
            id: "q1",
            blueprintItemId: "bp-search",
            questionType: "reasoning",
            difficulty: "advanced",
            sourceChunkIds: ["chunk-1", "chunk-2"],
            evidenceExcerptIds: [],
            sourcePaths: ["notes/retrieval.md", "notes/reranking.md"],
            conceptIds: ["exam-topic:18:4227dc00"],
            generationMetadata: {
                modelProvider: "openai-compatible",
                modelName: "cloud-exam-model",
                promptVersion: EXAM_QUESTION_GENERATION_PROMPT_VERSION,
                generatedAt: 1700000000000,
            },
        }]);
    });

    it("persists confirmed Concept IDs proven by a question's source chunks", async () => {
        const generator = createGenerator(JSON.stringify({ questions: [] }));
        const conceptIdsByChunk = new Map<string, readonly string[]>([
            ["chunk-1", ["concept:retrieval", "concept:keyword"]],
            ["chunk-2", ["concept:reranking", "concept:retrieval"]],
        ]);

        const result = await generator.generateQuestions(
            createBlueprint(),
            createChunks(),
            undefined,
            undefined,
            conceptIdsByChunk,
        );

        expect(result.questions[0]?.conceptIds).toEqual([
            "concept:keyword",
            "concept:reranking",
            "concept:retrieval",
        ]);
    });

    it("keeps a simple-mode multiple-choice question locally scoreable", async () => {
        const generator = createGenerator(JSON.stringify({
            questions: [{
                blueprint_item_id: "bp-search",
                question: "检索策略中哪项用于语义召回？",
                reference_answer: "向量检索用于语义召回。",
                rubric: "本题按 100 分制评分；选择正确得 100 分。",
                options: [
                    { id: "option-a", text: "关键词检索" },
                    { id: "option-b", text: "向量检索" },
                    { id: "option-c", text: "重排" },
                ],
                correct_option_id: "option-b",
                source_chunk_ids: ["chunk-1"],
                evidence_excerpt_ids: ["E1"],
            }],
        }));

        const result = await generator.generateQuestions(createSimpleBlueprint(), createChunks());

        expect(result.questions[0]).toMatchObject({
            answerForm: "single-choice",
            correctOptionId: "option-b",
            options: [
                { id: "option-a", text: "关键词检索" },
                { id: "option-b", text: "向量检索" },
                { id: "option-c", text: "重排" },
            ],
        });
    });
});
