import { describe, expect, it, vi } from "vitest";
import {
    ASSESSMENT_INDEX_PATH,
    ASSESSMENT_SESSIONS_DIR_PATH,
} from "../../../src/constants";
import type { AssessmentSessionDocumentV1 } from "../../../src/domain/assessment/assessment-types";
import {
    JsonAssessmentSessionStore,
    type AssessmentStorageAdapter,
} from "../../../src/infrastructure/storage/json-assessment-session-store";

class InMemoryAssessmentStorageAdapter implements AssessmentStorageAdapter {
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

    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
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
}

function createDocument(sessionId = "session-1", savedAt = 100): AssessmentSessionDocumentV1 {
    return {
        schemaVersion: 1,
        sessionId,
        savedAt,
        examSession: {
            id: sessionId,
            title: "JSON 考试事实测试",
            createdAt: 10,
            scopeLabel: "完整知识库",
            selectedFolderPaths: [],
            excludedFilePaths: [],
            forceIncludedFilePaths: [],
            questions: [],
            userAnswers: [],
            evaluation: null,
            savedPath: ".vault-coach/exams/session-1-JSON.md",
            status: "saved",
        },
        assessmentEvents: [{
            id: "event-1",
            eventType: "exam-answer",
            sessionId,
            questionId: "q1",
            conceptIds: ["exam-topic:json"],
            sourceChunkIds: ["chunk-json"],
            rawScore: 80,
            normalizedScore: 0.8,
            difficulty: "basic",
            questionType: "explanation",
            errorCodes: [],
            evidenceConfidence: 1,
            evaluationConfidence: 0.8,
            occurredAt: 99,
            evaluator: { provider: "ollama", model: "test-model", promptVersion: "evaluation/v2" },
        }],
        conceptBindings: [{
            id: "exam-topic:json",
            label: "JSON 测试",
            sourceBlueprintItemId: "bp-json",
            kind: "provisional-topic",
        }],
    };
}

describe("JsonAssessmentSessionStore", () => {
    it("writes a validated versioned session document and rebuildable index through temporary files", async () => {
        const adapter = new InMemoryAssessmentStorageAdapter();
        const store = new JsonAssessmentSessionStore(adapter);
        const document = createDocument();

        await store.save(document);

        const sessionPath = `${ASSESSMENT_SESSIONS_DIR_PATH}/session-1.json`;
        expect(JSON.parse(adapter.files.get(sessionPath) ?? "")).toEqual(document);
        expect(JSON.parse(adapter.files.get(ASSESSMENT_INDEX_PATH) ?? "")).toEqual({
            schemaVersion: 1,
            entries: [{
                sessionId: "session-1",
                sessionPath,
                reportPath: ".vault-coach/exams/session-1-JSON.md",
                title: "JSON 考试事实测试",
                createdAt: 10,
                score: null,
                maxScore: null,
                updatedAt: 100,
            }],
        });
        expect(Array.from(adapter.files.keys()).some((path: string) => path.endsWith(".tmp"))).toBe(false);
    });

    it("rebuilds a damaged index from session facts without modifying the session JSON", async () => {
        const adapter = new InMemoryAssessmentStorageAdapter();
        const store = new JsonAssessmentSessionStore(adapter);
        const document = createDocument();
        await store.save(document);
        const sessionPath = `${ASSESSMENT_SESSIONS_DIR_PATH}/session-1.json`;
        const originalSessionJson = adapter.files.get(sessionPath);
        adapter.files.set(ASSESSMENT_INDEX_PATH, "{ damaged index");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(store.list()).resolves.toEqual([document]);

        expect(adapter.files.get(sessionPath)).toBe(originalSessionJson);
        expect(JSON.parse(adapter.files.get(ASSESSMENT_INDEX_PATH) ?? "")).toMatchObject({
            schemaVersion: 1,
            entries: [{ sessionId: "session-1" }],
        });
        expect(warn).toHaveBeenCalledOnce();
    });

    it("recovers a valid interrupted session write and leaves no temporary file behind", async () => {
        const adapter = new InMemoryAssessmentStorageAdapter();
        const store = new JsonAssessmentSessionStore(adapter);
        const document = createDocument();
        const temporaryPath = `${ASSESSMENT_SESSIONS_DIR_PATH}/session-1.json.tmp`;
        adapter.files.set(temporaryPath, JSON.stringify(document));

        await expect(store.read("session-1")).resolves.toEqual(document);

        expect(adapter.files.has(temporaryPath)).toBe(false);
        expect(adapter.files.has(`${ASSESSMENT_SESSIONS_DIR_PATH}/session-1.json`)).toBe(true);
    });

    it("rejects malformed facts without overwriting a session or silently indexing it", async () => {
        const adapter = new InMemoryAssessmentStorageAdapter();
        const store = new JsonAssessmentSessionStore(adapter);
        const malformedDocument = {
            ...createDocument(),
            assessmentEvents: [{ eventType: "exam-answer", sessionId: "session-1" }],
        };

        await expect(store.save(malformedDocument as AssessmentSessionDocumentV1)).rejects.toThrow("Assessment Event 格式无效");
        expect(adapter.files.has(`${ASSESSMENT_SESSIONS_DIR_PATH}/session-1.json`)).toBe(false);
        expect(adapter.files.has(ASSESSMENT_INDEX_PATH)).toBe(false);
    });
});
