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
    type AssessmentExamHistoryItem,
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

/** Returns the canonical facts path for one validated Assessment Session ID. */
export function getAssessmentSessionPath(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        throw new Error(`无效的 Assessment Session ID：${sessionId}`);
    }

    return normalizePath(`${ASSESSMENT_SESSIONS_DIR_PATH}/${sessionId}.json`);
}

/** Resolves only canonical Assessment Session paths, rejecting path traversal. */
export function getAssessmentSessionIdFromPath(path: string): string | null {
    const normalizedPath = normalizePath(path);
    const match = new RegExp(`^${ASSESSMENT_SESSIONS_DIR_PATH}/([a-zA-Z0-9_-]+)\\.json$`).exec(normalizedPath);
    const sessionId = match?.[1];
    return sessionId && getAssessmentSessionPath(sessionId) === normalizedPath ? sessionId : null;
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
        this.assertDocument(document, getAssessmentSessionPath(document.sessionId));

        await this.writeJsonAtomically(
            getAssessmentSessionPath(document.sessionId),
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
        const path = getAssessmentSessionPath(sessionId);
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

    async listHistory(): Promise<AssessmentExamHistoryItem[]> {
        const documents = await this.list();
        return documents
            .map((document: AssessmentSessionDocumentV1) => this.createHistoryItem(document))
            .sort((left: AssessmentExamHistoryItem, right: AssessmentExamHistoryItem) => {
                return (right.createdAt ?? right.modifiedAt ?? 0) - (left.createdAt ?? left.modifiedAt ?? 0);
            });
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
        const backupPath = `${normalizedPath}.bak`;
        const serialized = JSON.stringify(payload, null, 2);

        await this.adapter.write(temporaryPath, serialized);
        let temporaryPayload: unknown;
        try {
            temporaryPayload = JSON.parse(await this.adapter.read(temporaryPath));
        } catch (error: unknown) {
            throw new Error(`Assessment 临时 JSON 无法解析：${temporaryPath}（${this.describeError(error)}）`);
        }
        assertPayload(temporaryPayload, temporaryPath);

        if (!(await this.adapter.exists(normalizedPath))) {
            await this.adapter.rename(temporaryPath, normalizedPath);
            return;
        }

        // Obsidian's adapter.rename() rejects an existing destination. Keep a
        // recoverable copy of the old value before replacing it so a failed
        // move cannot silently discard a session's evidence.
        if (await this.adapter.exists(backupPath)) {
            await this.adapter.remove(backupPath);
        }
        await this.adapter.write(backupPath, await this.adapter.read(normalizedPath));

        try {
            await this.adapter.remove(normalizedPath);
            await this.adapter.rename(temporaryPath, normalizedPath);
        } catch (error: unknown) {
            await this.restoreBackup(normalizedPath, backupPath);
            throw error;
        }

        try {
            if (await this.adapter.exists(backupPath)) {
                await this.adapter.remove(backupPath);
            }
        } catch (error: unknown) {
            console.warn("[VaultCoach] Assessment JSON 已更新，但旧备份文件暂未清理", backupPath, error);
        }
    }

    private async recoverTemporaryFiles(): Promise<void> {
        const listedDirectories = await Promise.all([
            this.adapter.list(ASSESSMENTS_DIR_PATH),
            this.adapter.list(ASSESSMENT_SESSIONS_DIR_PATH),
        ]);
        const finalPaths = Array.from(new Set(listedDirectories.flatMap((listed) => listed.files)
            .flatMap((path: string) => this.getStagedFinalPath(path))))
            .sort((left: string, right: string) => left.localeCompare(right));

        for (const finalPath of finalPaths) {
            await this.recoverStagedFile(finalPath);
        }
    }

    private async recoverStagedFile(finalPath: string): Promise<void> {
        const temporaryPath = `${finalPath}.tmp`;
        const backupPath = `${finalPath}.bak`;
        if (await this.adapter.exists(finalPath)) {
            await this.removeStagedFileIfPresent(temporaryPath);
            await this.removeStagedFileIfPresent(backupPath);
            return;
        }

        for (const stagedPath of [temporaryPath, backupPath]) {
            if (!(await this.adapter.exists(stagedPath))) {
                continue;
            }

            try {
                const payload: unknown = JSON.parse(await this.adapter.read(stagedPath));
                this.assertStagedPayload(payload, finalPath, stagedPath);
                await this.adapter.rename(stagedPath, finalPath);
                await this.removeStagedFileIfPresent(temporaryPath);
                await this.removeStagedFileIfPresent(backupPath);
                return;
            } catch (error: unknown) {
                console.warn("[VaultCoach] 保留无法恢复的 Assessment 临时文件", stagedPath, error);
            }
        }
    }

    private getStagedFinalPath(path: string): string[] {
        if (path.endsWith(".tmp")) {
            return [path.slice(0, -".tmp".length)];
        }
        if (path.endsWith(".bak")) {
            return [path.slice(0, -".bak".length)];
        }

        return [];
    }

    private assertStagedPayload(payload: unknown, finalPath: string, stagedPath: string): void {
        if (normalizePath(finalPath) === ASSESSMENT_INDEX_PATH) {
            this.assertIndex(payload, stagedPath);
            return;
        }

        this.assertDocument(payload, stagedPath);
    }

    private async restoreBackup(finalPath: string, backupPath: string): Promise<void> {
        if (await this.adapter.exists(finalPath) || !(await this.adapter.exists(backupPath))) {
            return;
        }

        try {
            await this.adapter.rename(backupPath, finalPath);
        } catch (error: unknown) {
            console.error("[VaultCoach] 无法立即恢复 Assessment JSON 备份", backupPath, error);
        }
    }

    private async removeStagedFileIfPresent(path: string): Promise<void> {
        if (await this.adapter.exists(path)) {
            await this.adapter.remove(path);
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

    private createIndexEntry(document: AssessmentSessionDocumentV1): AssessmentSessionIndexEntry {
        return {
            sessionId: document.sessionId,
            sessionPath: getAssessmentSessionPath(document.sessionId),
            reportPath: document.examSession.savedPath,
            title: document.examSession.title,
            createdAt: document.examSession.createdAt,
            score: document.examSession.evaluation?.score ?? null,
            maxScore: document.examSession.evaluation?.maxScore ?? null,
            updatedAt: document.savedAt,
        };
    }

    private createHistoryItem(document: AssessmentSessionDocumentV1): AssessmentExamHistoryItem {
        const sessionPath = getAssessmentSessionPath(document.sessionId);
        return {
            path: sessionPath,
            sessionId: document.sessionId,
            sessionPath,
            reportPath: document.examSession.savedPath,
            title: document.examSession.title,
            createdAt: document.examSession.createdAt,
            score: document.examSession.evaluation?.score ?? null,
            maxScore: document.examSession.evaluation?.maxScore ?? null,
            modifiedAt: document.savedAt,
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
                || typeof event.evaluator.promptVersion !== "string"
                || (event.evaluator.kind !== undefined && event.evaluator.kind !== "model" && event.evaluator.kind !== "deterministic")
                || (event.adaptive !== undefined && !this.isValidAdaptiveEventAudit(event.adaptive))) {
                throw new Error(`Assessment Event 格式无效：${path}`);
            }
        }

        if (value.examSession.adaptivePlan !== undefined && !this.isValidAdaptivePlanAudit(value.examSession.adaptivePlan, value.examSession.examMode)) {
            throw new Error(`Assessment Session 自适应考试计划格式无效：${path}`);
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
                || normalizePath(entry.sessionPath) !== getAssessmentSessionPath(entry.sessionId)
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

    private isValidAdaptiveEventAudit(value: unknown): boolean {
        return this.isRecord(value)
            && typeof value.planId === "string"
            && this.isAdaptiveTargetMode(value.targetMode)
            && Array.isArray(value.plannedTargetConceptIds)
            && value.plannedTargetConceptIds.every((conceptId) => typeof conceptId === "string");
    }

    private isValidAdaptivePlanAudit(value: unknown, examMode: unknown): boolean {
        if (!this.isRecord(value)
            || typeof value.planId !== "string"
            || typeof value.algorithmVersion !== "string"
            || typeof value.inputFingerprint !== "string"
            || typeof value.scopeSignature !== "string"
            || !this.isAdaptiveTargetMode(value.targetMode)
            || (value.examMode !== "simple" && value.examMode !== "challenge")
            || value.examMode !== examMode
            || !Array.isArray(value.targetConceptIds)
            || !value.targetConceptIds.every((conceptId) => typeof conceptId === "string")
            || !Array.isArray(value.appliedFallbacks)
            || !value.appliedFallbacks.every((reason) => this.isAdaptiveReasonCode(reason))
            || !this.isRecord(value.reasonCodesByConceptId)) {
            return false;
        }
        return Object.values(value.reasonCodesByConceptId).every((reasons) => {
            return Array.isArray(reasons) && reasons.every((reason) => this.isAdaptiveReasonCode(reason));
        });
    }

    private isAdaptiveTargetMode(value: unknown): boolean {
        return value === "diagnostic" || value === "weak-review" || value === "prerequisite" || value === "mixed";
    }

    private isAdaptiveReasonCode(value: unknown): boolean {
        return value === "unassessed" || value === "low-confidence" || value === "weak-mastery"
            || value === "developing-mastery" || value === "review-due" || value === "confirmed-prerequisite"
            || value === "recently-covered" || value === "insufficient-evidence" || value === "scope-capacity-limited";
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    private describeError(error: unknown): string {
        return error instanceof Error ? error.message : "unknown error";
    }
}
