import { normalizePath } from "obsidian";
import {
    ASSESSMENT_INDEX_PATH,
    ASSESSMENT_SESSIONS_DIR_PATH,
    ASSESSMENTS_DIR_PATH,
    VAULT_COACH_HIDDEN_DIR_PATH,
} from "../../constants";
import {
    ASSESSMENT_INDEX_SCHEMA_VERSION,
    ASSESSMENT_SESSION_SCHEMA_VERSION,
    type AssessmentSessionDocumentV1,
    type AssessmentSessionIndexEntry,
    type AssessmentSessionIndexV1,
    type AssessmentSessionStore,
} from "../../domain/assessment/assessment-types";

/** Minimal Vault adapter surface required by Assessment JSON persistence. */
export interface AssessmentStorageAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    mkdir(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    remove(path: string): Promise<void>;
}

/**
 * Obsidian Vault-adapter implementation of the M1 Assessment facts store.
 *
 * Session JSON is the source of truth. `index-v1.json` is a rebuildable listing
 * cache and must never be allowed to overwrite or discard a session document.
 */
export class JsonAssessmentSessionStore implements AssessmentSessionStore {
    constructor(private readonly adapter: AssessmentStorageAdapter) {}

    async save(document: AssessmentSessionDocumentV1): Promise<void> {
        await this.ensureDirectories();
        await this.recoverTemporaryFiles();
        this.assertDocument(document, this.getSessionPath(document.sessionId));

        await this.writeJsonAtomically(
            this.getSessionPath(document.sessionId),
            document,
            (payload: unknown, path: string) => this.assertDocument(payload, path),
        );

        const index = await this.readIndexOrRebuild();
        const entry = this.createIndexEntry(document);
        const entries = [
            ...index.entries.filter((item: AssessmentSessionIndexEntry) => item.sessionId !== document.sessionId),
            entry,
        ].sort((left: AssessmentSessionIndexEntry, right: AssessmentSessionIndexEntry) => right.updatedAt - left.updatedAt);
        await this.writeIndex({
            schemaVersion: ASSESSMENT_INDEX_SCHEMA_VERSION,
            entries,
        });
    }

    async read(sessionId: string): Promise<AssessmentSessionDocumentV1 | null> {
        await this.ensureDirectories();
        await this.recoverTemporaryFiles();
        const path = this.getSessionPath(sessionId);
        if (!(await this.adapter.exists(path))) {
            return null;
        }

        return this.readDocumentAtPath(path);
    }

    async list(): Promise<AssessmentSessionDocumentV1[]> {
        await this.ensureDirectories();
        await this.recoverTemporaryFiles();
        let index = await this.readIndexOrRebuild();
        let documents = await this.readDocumentsFromIndex(index);

        if (documents === null) {
            index = await this.rebuildIndex();
            documents = await this.readDocumentsFromIndex(index);
        }

        return documents ?? [];
    }

    async rebuildIndex(): Promise<AssessmentSessionIndexV1> {
        await this.ensureDirectories();
        await this.recoverTemporaryFiles();
        const listed = await this.adapter.list(ASSESSMENT_SESSIONS_DIR_PATH);
        const entries: AssessmentSessionIndexEntry[] = [];

        for (const path of listed.files
            .filter((filePath: string) => filePath.toLowerCase().endsWith(".json"))
            .sort((left: string, right: string) => left.localeCompare(right))) {
            try {
                const document = await this.readDocumentAtPath(path);
                entries.push(this.createIndexEntry(document));
            } catch (error: unknown) {
                console.warn("[VaultCoach] 跳过损坏的 Assessment Session JSON", path, error);
            }
        }

        const index: AssessmentSessionIndexV1 = {
            schemaVersion: ASSESSMENT_INDEX_SCHEMA_VERSION,
            entries: entries.sort((left, right) => right.updatedAt - left.updatedAt),
        };
        await this.writeIndex(index);
        return index;
    }

    private async readDocumentsFromIndex(
        index: AssessmentSessionIndexV1,
    ): Promise<AssessmentSessionDocumentV1[] | null> {
        const documents: AssessmentSessionDocumentV1[] = [];
        for (const entry of index.entries) {
            try {
                const document = await this.readDocumentAtPath(entry.sessionPath);
                if (document.sessionId !== entry.sessionId) {
                    return null;
                }
                documents.push(document);
            } catch {
                return null;
            }
        }

        return documents;
    }

    private async readIndexOrRebuild(): Promise<AssessmentSessionIndexV1> {
        const index = await this.tryReadIndex();
        return index ?? this.rebuildIndex();
    }

    private async tryReadIndex(): Promise<AssessmentSessionIndexV1 | null> {
        if (!(await this.adapter.exists(ASSESSMENT_INDEX_PATH))) {
            return null;
        }

        try {
            const raw = await this.adapter.read(ASSESSMENT_INDEX_PATH);
            const payload: unknown = JSON.parse(raw);
            this.assertIndex(payload, ASSESSMENT_INDEX_PATH);
            return payload;
        } catch (error: unknown) {
            console.warn("[VaultCoach] Assessment 索引不可用，将从 session JSON 重建。", error);
            return null;
        }
    }

    private async readDocumentAtPath(path: string): Promise<AssessmentSessionDocumentV1> {
        let payload: unknown;
        try {
            payload = JSON.parse(await this.adapter.read(path));
        } catch (error: unknown) {
            throw new Error(`Assessment Session JSON 无法解析：${path}（${this.describeError(error)}）`);
        }

        this.assertDocument(payload, path);
        return payload;
    }

    private async writeIndex(index: AssessmentSessionIndexV1): Promise<void> {
        await this.writeJsonAtomically(
            ASSESSMENT_INDEX_PATH,
            index,
            (payload: unknown, path: string) => this.assertIndex(payload, path),
        );
    }

    private async writeJsonAtomically(
        path: string,
        payload: unknown,
        assertPayload: (value: unknown, path: string) => void,
    ): Promise<void> {
        const normalizedPath = normalizePath(path);
        const temporaryPath = `${normalizedPath}.tmp`;
        const serialized = JSON.stringify(payload, null, 2);

        await this.adapter.write(temporaryPath, serialized);
        let temporaryPayload: unknown;
        try {
            temporaryPayload = JSON.parse(await this.adapter.read(temporaryPath));
        } catch (error: unknown) {
            throw new Error(`Assessment 临时 JSON 无法解析：${temporaryPath}（${this.describeError(error)}）`);
        }
        assertPayload(temporaryPayload, temporaryPath);

        await this.adapter.rename(temporaryPath, normalizedPath);
    }

    private async recoverTemporaryFiles(): Promise<void> {
        const listedDirectories = await Promise.all([
            this.adapter.list(ASSESSMENTS_DIR_PATH),
            this.adapter.list(ASSESSMENT_SESSIONS_DIR_PATH),
        ]);
        const temporaryPaths = Array.from(new Set(listedDirectories.flatMap((listed) => listed.files)))
            .filter((path: string) => path.endsWith(".tmp"))
            .sort((left: string, right: string) => left.localeCompare(right));

        for (const temporaryPath of temporaryPaths) {
            const finalPath = temporaryPath.slice(0, -".tmp".length);
            if (await this.adapter.exists(finalPath)) {
                await this.adapter.remove(temporaryPath);
                continue;
            }

            try {
                const raw = await this.adapter.read(temporaryPath);
                const payload: unknown = JSON.parse(raw);
                if (normalizePath(finalPath) === ASSESSMENT_INDEX_PATH) {
                    this.assertIndex(payload, temporaryPath);
                } else {
                    this.assertDocument(payload, temporaryPath);
                }
                await this.adapter.rename(temporaryPath, finalPath);
            } catch (error: unknown) {
                console.warn("[VaultCoach] 保留无法恢复的 Assessment 临时文件", temporaryPath, error);
            }
        }
    }

    private async ensureDirectories(): Promise<void> {
        for (const path of [VAULT_COACH_HIDDEN_DIR_PATH, ASSESSMENTS_DIR_PATH, ASSESSMENT_SESSIONS_DIR_PATH]) {
            const normalizedPath = normalizePath(path);
            if (!(await this.adapter.exists(normalizedPath))) {
                await this.adapter.mkdir(normalizedPath);
            }
        }
    }

    private getSessionPath(sessionId: string): string {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
            throw new Error(`无效的 Assessment Session ID：${sessionId}`);
        }

        return normalizePath(`${ASSESSMENT_SESSIONS_DIR_PATH}/${sessionId}.json`);
    }

    private createIndexEntry(document: AssessmentSessionDocumentV1): AssessmentSessionIndexEntry {
        return {
            sessionId: document.sessionId,
            sessionPath: this.getSessionPath(document.sessionId),
            reportPath: document.examSession.savedPath,
            title: document.examSession.title,
            createdAt: document.examSession.createdAt,
            score: document.examSession.evaluation?.score ?? null,
            maxScore: document.examSession.evaluation?.maxScore ?? null,
            updatedAt: document.savedAt,
        };
    }

    private assertDocument(value: unknown, path: string): asserts value is AssessmentSessionDocumentV1 {
        if (!this.isRecord(value)
            || value.schemaVersion !== ASSESSMENT_SESSION_SCHEMA_VERSION
            || typeof value.sessionId !== "string"
            || value.sessionId.length === 0
            || !this.isRecord(value.examSession)
            || value.examSession.id !== value.sessionId
            || !Array.isArray(value.assessmentEvents)
            || !Array.isArray(value.conceptBindings)
            || typeof value.savedAt !== "number"
            || !Number.isFinite(value.savedAt)) {
            throw new Error(`Assessment Session JSON 格式无效：${path}`);
        }

        for (const event of value.assessmentEvents) {
            if (!this.isRecord(event)
                || event.eventType !== "exam-answer"
                || event.sessionId !== value.sessionId
                || typeof event.id !== "string"
                || typeof event.questionId !== "string"
                || !Array.isArray(event.conceptIds)
                || !Array.isArray(event.sourceChunkIds)
                || typeof event.rawScore !== "number"
                || typeof event.normalizedScore !== "number"
                || typeof event.evidenceConfidence !== "number"
                || typeof event.evaluationConfidence !== "number"
                || typeof event.occurredAt !== "number"
                || !this.isRecord(event.evaluator)
                || typeof event.evaluator.provider !== "string"
                || typeof event.evaluator.model !== "string"
                || typeof event.evaluator.promptVersion !== "string") {
                throw new Error(`Assessment Event 格式无效：${path}`);
            }
        }

        for (const binding of value.conceptBindings) {
            if (!this.isRecord(binding)
                || typeof binding.id !== "string"
                || typeof binding.label !== "string"
                || typeof binding.sourceBlueprintItemId !== "string"
                || binding.kind !== "provisional-topic") {
                throw new Error(`Assessment Concept binding 格式无效：${path}`);
            }
        }
    }

    private assertIndex(value: unknown, path: string): asserts value is AssessmentSessionIndexV1 {
        if (!this.isRecord(value)
            || value.schemaVersion !== ASSESSMENT_INDEX_SCHEMA_VERSION
            || !Array.isArray(value.entries)) {
            throw new Error(`Assessment 索引格式无效：${path}`);
        }

        for (const entry of value.entries) {
            if (!this.isRecord(entry)
                || typeof entry.sessionId !== "string"
                || typeof entry.sessionPath !== "string"
                || normalizePath(entry.sessionPath) !== this.getSessionPath(entry.sessionId)
                || (entry.reportPath !== null && typeof entry.reportPath !== "string")
                || typeof entry.title !== "string"
                || typeof entry.createdAt !== "number"
                || (entry.score !== null && typeof entry.score !== "number")
                || (entry.maxScore !== null && typeof entry.maxScore !== "number")
                || typeof entry.updatedAt !== "number") {
                throw new Error(`Assessment 索引条目格式无效：${path}`);
            }
        }
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    private describeError(error: unknown): string {
        return error instanceof Error ? error.message : "unknown error";
    }
}
