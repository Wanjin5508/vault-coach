import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Stat } from "obsidian";
import type { TranslationKey } from "../src/i18n";
import {
    EXAM_MARKDOWN_PROJECTION_VERSION,
    formatAssessmentSessionMarkdown,
    formatExamSessionMarkdown,
    parseExamHistoryItem,
    parseExamHistorySessionId,
} from "../src/exam/exam-session-markdown";
import type { AssessmentSessionDocumentV1 } from "../src/domain/assessment/assessment-types";
import type { ExamEvaluation, ExamSession } from "../src/domain/exam/exam-types";

const labels: Record<string, string> = {
    "exam.markdown.id": "ID",
    "exam.markdown.createdAt": "创建时间",
    "exam.markdown.scope": "范围",
    "exam.markdown.questionCount": "题目数量",
    "exam.markdown.score": "得分",
    "exam.markdown.overallFeedback": "总体反馈",
    "exam.markdown.questions": "题目",
    "exam.markdown.userAnswer": "用户答案",
    "exam.markdown.referenceAnswer": "参考答案",
    "exam.markdown.rubric": "评分标准",
    "exam.markdown.evaluation": "评分",
    "exam.markdown.feedback": "反馈",
    "exam.markdown.improvement": "改进建议",
    "exam.markdown.sources": "来源",
    "exam.unanswered": "未作答",
    "exam.defaultTitle": "VaultCoach 测试",
};

function translate(key: TranslationKey, replacements?: Record<string, string | number>): string {
    void replacements;
    return labels[key] ?? key;
}

function readFixture(name: string): string {
    const fixturePath = fileURLToPath(new URL(`./fixtures/vault-exam-history/${name}`, import.meta.url));
    return readFileSync(fixturePath, "utf8");
}

function createSession(evaluation: ExamEvaluation | null): ExamSession {
    return {
        id: "exam_20240102030405",
        title: "RAG 基础测试",
        createdAt: 1704164645000,
        scopeLabel: "知识库/RAG",
        selectedFolderPaths: ["知识库/RAG"],
        excludedFilePaths: [],
        forceIncludedFilePaths: [],
        questions: [
            {
                id: "q1",
                blueprintItemId: "bp-rag",
                question: "什么是混合检索？",
                referenceAnswer: "混合检索结合关键词和向量检索。",
                rubric: "按覆盖关键点的程度使用 100 分制评分。",
                questionType: "explanation",
                difficulty: "basic",
                sourceChunkIds: ["chunk-rag"],
                evidenceExcerptIds: ["E1"],
                sourcePaths: ["知识库/RAG/混合检索.md"],
                conceptIds: ["exam-topic:rag"],
                generationMetadata: {
                    modelProvider: "ollama",
                    modelName: "test-model",
                    promptVersion: "test/v1",
                    generatedAt: 1,
                },
            },
        ],
        userAnswers: ["结合关键词和向量检索。"],
        evaluation,
        savedPath: null,
        status: evaluation ? "submitted" : "draft",
    };
}

describe("exam session markdown compatibility", () => {
    it("preserves the current markdown output contract", () => {
        const session = createSession({
            score: 82,
            maxScore: 100,
            overallFeedback: "总体掌握良好。",
            items: [{
                questionId: "q1",
                score: 82,
                maxScore: 100,
                feedback: "覆盖了主要概念。",
                improvement: "补充检索融合细节。",
                coveredKeyPoints: [],
                missingKeyPoints: [],
                errorCodes: [],
                evaluationConfidence: 0,
                evaluator: {
                    modelProvider: "ollama",
                    modelName: "test-model",
                    promptVersion: "test/v1",
                    evaluatedAt: 1,
                },
            }],
        });

        const markdown = formatExamSessionMarkdown(session, translate);

        expect(markdown).toContain("vaultCoachExam: true");
        expect(markdown).toContain('examId: "exam_20240102030405"');
        expect(markdown).toContain("createdAt: 1704164645000");
        expect(markdown).toContain("score: 82");
        expect(markdown).toContain("maxScore: 100");
        expect(markdown).not.toContain("vaultCoachAssessmentProjection");
        expect(markdown).toContain("# RAG 基础测试");
        expect(markdown).toContain("什么是混合检索？");
        expect(markdown).toContain("结合关键词和向量检索。");
        expect(markdown).toContain("[[知识库/RAG/混合检索.md]]");
    });

    it("preserves the current unevaluated-report contract", () => {
        const session: ExamSession = { ...createSession(null), userAnswers: [] };
        const markdown = formatExamSessionMarkdown(session, translate);

        expect(markdown).toContain("vaultCoachExam: true");
        expect(markdown).toContain("score: ");
        expect(markdown).toContain("maxScore: ");
        expect(markdown).not.toContain("## 总体反馈");
        expect(markdown).not.toContain("\n#### 评分\n");
        expect(markdown).toContain("未作答");
        expect(markdown).toContain("#### 参考答案");
        expect(markdown).toContain("#### 评分标准");
    });

    it("formats the same assessment facts into an identical Markdown projection", () => {
        const session = createSession(null);
        const document: AssessmentSessionDocumentV1 = {
            schemaVersion: 1,
            sessionId: session.id,
            savedAt: 2,
            examSession: session,
            assessmentEvents: [],
            conceptBindings: [],
        };
        const sessionPath = `.vault-coach/assessments/sessions/${session.id}.json`;

        const firstProjection = formatAssessmentSessionMarkdown(document, sessionPath, translate);
        const secondProjection = formatAssessmentSessionMarkdown(document, sessionPath, translate);

        expect(firstProjection).toBe(secondProjection);
        expect(firstProjection).toContain("vaultCoachAssessmentProjection: true");
        expect(firstProjection).toContain(`assessmentProjectionVersion: ${EXAM_MARKDOWN_PROJECTION_VERSION}`);
        expect(firstProjection).toContain(`assessmentSessionPath: ${JSON.stringify(sessionPath)}`);
    });

    it("reads current frontmatter history", () => {
        const stat: Stat = { ctime: 1704164645000, mtime: 1704165000000, size: 256, type: "file" };
        const item = parseExamHistoryItem(".vault-coach/exams/current.md", readFixture("current.md"), stat, translate);

        expect(item).toEqual({
            path: ".vault-coach/exams/current.md",
            title: "当前考试记录",
            createdAt: 1704164645000,
            score: 82,
            maxScore: 100,
            modifiedAt: 1704165000000,
        });
        expect(parseExamHistorySessionId(readFixture("current.md"))).toBe("exam_20240102030405");
    });

    it("reads legacy Chinese history without frontmatter", () => {
        const item = parseExamHistoryItem(
            ".vault-coach/exams/legacy-zh.md",
            readFixture("legacy-zh.md"),
            null,
            translate,
        );

        expect(item.title).toBe("旧中文考试记录");
        expect(item.createdAt).toBe(Date.parse("2024-01-02T03:04:05.000Z"));
        expect(item.score).toBe(75);
        expect(item.maxScore).toBe(100);
        expect(item.modifiedAt).toBeNull();
        expect(parseExamHistorySessionId(readFixture("legacy-zh.md"))).toBeNull();
    });

    it("reads legacy English history without frontmatter", () => {
        const item = parseExamHistoryItem(
            ".vault-coach/exams/legacy-en.md",
            readFixture("legacy-en.md"),
            null,
            translate,
        );

        expect(item.title).toBe("Legacy English Exam");
        expect(item.createdAt).toBe(Date.parse("2024-02-03T04:05:06.000Z"));
        expect(item.score).toBe(64);
        expect(item.maxScore).toBe(100);
    });

    it("reads a legacy unscored record without inventing scores", () => {
        const item = parseExamHistoryItem(
            ".vault-coach/exams/legacy-unscored.md",
            readFixture("legacy-unscored.md"),
            null,
            translate,
        );

        expect(item).toEqual({
            path: ".vault-coach/exams/legacy-unscored.md",
            title: "未评分的旧考试记录",
            createdAt: Date.parse("2024-03-04T05:06:07.000Z"),
            score: null,
            maxScore: null,
            modifiedAt: null,
        });
    });
});
