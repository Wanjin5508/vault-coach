import { describe, expect, it } from "vitest";
import type { ListedFiles, Stat } from "obsidian";
import { ASSESSMENT_SESSIONS_DIR_PATH } from "../../../src/constants";
import type { AssessmentSessionDocumentV1 } from "../../../src/domain/assessment/assessment-types";
import type { TranslationKey } from "../../../src/i18n";
import {
    JsonAssessmentSessionStore,
    type AssessmentStorageAdapter,
} from "../../../src/infrastructure/storage/json-assessment-session-store";
import {
    MarkdownExamReportStore,
    type MarkdownExamReportStorageAdapter,
} from "../../../src/infrastructure/storage/markdown-exam-report-store";

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
    "exam.defaultTitle": "VaultCoach 测试",
    "exam.notice.invalidHistoryPath": "无效路径",
    "exam.notice.exportPathIsFile": "导出位置是文件",
};

function translate(key: TranslationKey, replacements?: Record<string, string | number>): string {
    void replacements;
    return labels[key] ?? key;
}

class InMemoryStorageAdapter implements AssessmentStorageAdapter, MarkdownExamReportStorageAdapter {
    readonly files = new Map<string, string>();
    readonly directories = new Set<string>();

    async exists(path: string): Promise<boolean> {
        return this.files.has(path) || this.directories.has(path);
    }

    async read(path: string): Promise<string> {
        const content = this.files.get(path);
        if (content === undefined) {
            throw new Error(`找不到测试文件：${path}`);
        }
        return content;
    }

    async write(path: string, data: string): Promise<void> {
        this.files.set(path, data);
    }

    async list(path: string): Promise<ListedFiles> {
        const normalizedPrefix = path.endsWith("/") ? path : `${path}/`;
        return {
            files: Array.from(this.files.keys()).filter((filePath: string) => filePath.startsWith(normalizedPrefix)),
            folders: Array.from(this.directories).filter((directoryPath: string) => directoryPath.startsWith(normalizedPrefix)),
        };
    }

    async mkdir(path: string): Promise<void> {
        this.directories.add(path);
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const content = await this.read(oldPath);
        this.files.set(newPath, content);
        this.files.delete(oldPath);
    }

    async remove(path: string): Promise<void> {
        this.files.delete(path);
    }

    async stat(path: string): Promise<Stat | null> {
        if (this.files.has(path)) {
            return { ctime: 1, mtime: 1, size: this.files.get(path)?.length ?? 0, type: "file" };
        }
        if (this.directories.has(path)) {
            return { ctime: 1, mtime: 1, size: 0, type: "folder" };
        }
        return null;
    }
}

function createDocument(): AssessmentSessionDocumentV1 {
    return {
        schemaVersion: 1,
        sessionId: "projection-session",
        savedAt: 100,
        examSession: {
            id: "projection-session",
            title: "Markdown 投影测试",
            createdAt: 10,
            scopeLabel: "完整知识库",
            selectedFolderPaths: [],
            excludedFilePaths: [],
            forceIncludedFilePaths: [],
            questions: [{
                id: "q1",
                blueprintItemId: "bp1",
                question: "什么是事实源？",
                referenceAnswer: "JSON 是事实源。",
                rubric: "说明 JSON 与投影的关系。",
                questionType: "explanation",
                difficulty: "basic",
                sourceChunkIds: ["chunk-1"],
                evidenceExcerptIds: ["E1"],
                sourcePaths: ["知识库/事实源.md"],
                conceptIds: ["exam-topic:facts"],
                generationMetadata: {
                    modelProvider: "ollama",
                    modelName: "test-model",
                    promptVersion: "generation/v1",
                    generatedAt: 1,
                },
            }],
            userAnswers: ["JSON 保存事实，Markdown 是投影。"],
            evaluation: {
                score: 100,
                maxScore: 100,
                overallFeedback: "回答正确。",
                items: [{
                    questionId: "q1",
                    score: 100,
                    maxScore: 100,
                    feedback: "完整。",
                    improvement: "保持。",
                    coveredKeyPoints: ["JSON"],
                    missingKeyPoints: [],
                    errorCodes: [],
                    evaluationConfidence: 0.9,
                    evaluator: {
                        modelProvider: "ollama",
                        modelName: "test-model",
                        promptVersion: "evaluation/v2",
                        evaluatedAt: 2,
                    },
                }],
            },
            savedPath: ".vault-coach/exams/projection-session-Markdown 投影测试.md",
            status: "saved",
        },
        assessmentEvents: [{
            id: "event-1",
            eventType: "exam-answer",
            sessionId: "projection-session",
            questionId: "q1",
            conceptIds: ["exam-topic:facts"],
            sourceChunkIds: ["chunk-1"],
            rawScore: 100,
            normalizedScore: 1,
            difficulty: "basic",
            questionType: "explanation",
            errorCodes: [],
            evidenceConfidence: 1,
            evaluationConfidence: 0.9,
            occurredAt: 10,
            evaluator: { provider: "ollama", model: "test-model", promptVersion: "evaluation/v2" },
        }],
        conceptBindings: [{
            id: "exam-topic:facts",
            label: "事实源",
            sourceBlueprintItemId: "bp1",
            kind: "provisional-topic",
        }],
    };
}

describe("MarkdownExamReportStore", () => {
    it("regenerates an identical Markdown projection without modifying JSON facts", async () => {
        const adapter = new InMemoryStorageAdapter();
        const document = createDocument();
        const factsStore = new JsonAssessmentSessionStore(adapter);
        const reportStore = new MarkdownExamReportStore(adapter, translate);
        const sessionPath = `${ASSESSMENT_SESSIONS_DIR_PATH}/${document.sessionId}.json`;

        await factsStore.save(document);
        const originalFacts = adapter.files.get(sessionPath);

        const savedSession = await reportStore.writeAssessmentProjection(document, sessionPath);
        const firstProjection = adapter.files.get(savedSession.savedPath ?? "");

        expect(firstProjection).toContain("vaultCoachAssessmentProjection: true");
        expect(firstProjection).toContain("assessmentSchemaVersion: 1");
        expect(firstProjection).toContain(`assessmentSessionPath: ${JSON.stringify(sessionPath)}`);
        expect(adapter.files.get(sessionPath)).toBe(originalFacts);

        await reportStore.deleteSession(savedSession);
        expect(adapter.files.has(savedSession.savedPath ?? "")).toBe(false);
        expect(adapter.files.get(sessionPath)).toBe(originalFacts);

        const recoveredProjection = await reportStore.readOrCreateAssessmentProjection(document, sessionPath);
        expect(recoveredProjection).toBe(firstProjection);
        expect(adapter.files.get(sessionPath)).toBe(originalFacts);
    });

    it("keeps the legacy save path free of assessment-projection metadata", async () => {
        const adapter = new InMemoryStorageAdapter();
        const reportStore = new MarkdownExamReportStore(adapter, translate);
        const document = createDocument();

        const savedSession = await reportStore.save(document.examSession);
        const markdown = adapter.files.get(savedSession.savedPath ?? "");

        expect(markdown).toContain("vaultCoachExam: true");
        expect(markdown).not.toContain("vaultCoachAssessmentProjection");
    });
});
