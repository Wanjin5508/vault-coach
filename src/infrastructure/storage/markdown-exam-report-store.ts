import { normalizePath, type ListedFiles, type Stat } from "obsidian";
import { EXAM_RESULTS_DIR_PATH, VAULT_COACH_HIDDEN_DIR_PATH } from "../../constants";
import type { AssessmentSessionDocumentV1 } from "../../domain/assessment/assessment-types";
import type { ExamHistoryItem, ExamSession } from "../../domain/exam/exam-types";
import type { TranslationKey } from "../../i18n";
import {
    formatAssessmentSessionMarkdown,
    formatExamSessionMarkdown,
    parseExamHistoryItem,
} from "../../exam/exam-session-markdown";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/** Minimal Vault-adapter surface required by Markdown exam reports. */
export interface MarkdownExamReportStorageAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    list(path: string): Promise<ListedFiles>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    stat(path: string): Promise<Stat | null>;
}

/**
 * Stores only the readable Markdown representation of an exam. It has no
 * dependency on the JSON facts store, so deleting a report can never delete
 * assessment events or concept bindings.
 */
export class MarkdownExamReportStore {
    constructor(
        private readonly adapter: MarkdownExamReportStorageAdapter,
        private readonly t: TranslateFn,
    ) {}

    /** Prepares the stable report path without performing any I/O. */
    prepareSessionForSave(session: ExamSession): ExamSession {
        return {
            ...session,
            savedPath: session.savedPath ?? this.createResultPath(session),
            status: "saved",
        };
    }

    /** Saves the legacy Markdown report format used by the current application. */
    async save(session: ExamSession): Promise<ExamSession> {
        await this.ensureResultsDirectory();

        const savedSession = this.prepareSessionForSave(session);

        await this.adapter.write(savedSession.savedPath!, formatExamSessionMarkdown(savedSession, this.t));
        return savedSession;
    }

    /**
     * Creates or refreshes a Markdown projection from an immutable Assessment
     * Session document. Callers still own persistence of the returned path in
     * the JSON source of truth.
     */
    async writeAssessmentProjection(
        document: AssessmentSessionDocumentV1,
        assessmentSessionPath: string,
    ): Promise<ExamSession> {
        await this.ensureResultsDirectory();

        const projectedSession = this.prepareSessionForSave(document.examSession);
        const projectedDocument: AssessmentSessionDocumentV1 = {
            ...document,
            examSession: projectedSession,
        };

        await this.adapter.write(
            projectedSession.savedPath!,
            formatAssessmentSessionMarkdown(projectedDocument, assessmentSessionPath, this.t),
        );
        return projectedSession;
    }

    async export(session: ExamSession, targetFolderPath: string): Promise<string> {
        const normalizedFolderPath: string = await this.ensureExportFolder(targetFolderPath);
        const exportPath: string = await this.createUniqueResultPath(normalizedFolderPath, session);
        await this.adapter.write(exportPath, formatExamSessionMarkdown(session, this.t));
        return exportPath;
    }

    async listHistory(): Promise<ExamHistoryItem[]> {
        await this.ensureResultsDirectory();

        const listedFiles: ListedFiles = await this.adapter.list(EXAM_RESULTS_DIR_PATH);
        const markdownPaths: string[] = listedFiles.files
            .filter((path: string) => path.toLowerCase().endsWith(".md"))
            .sort((leftPath: string, rightPath: string) => rightPath.localeCompare(leftPath));

        const items: ExamHistoryItem[] = [];
        for (const path of markdownPaths) {
            try {
                const [content, stat]: [string, Stat | null] = await Promise.all([
                    this.adapter.read(path),
                    this.adapter.stat(path),
                ]);
                items.push(parseExamHistoryItem(path, content, stat, this.t));
            } catch (error: unknown) {
                console.error("[VaultCoach] 读取考试历史失败", error);
            }
        }

        items.sort((left: ExamHistoryItem, right: ExamHistoryItem) => {
            return (right.createdAt ?? right.modifiedAt ?? 0) - (left.createdAt ?? left.modifiedAt ?? 0);
        });
        return items;
    }

    async readHistoryContent(path: string): Promise<string> {
        const normalizedPath: string = normalizePath(path);
        this.assertExamResultPath(normalizedPath);

        return this.adapter.read(normalizedPath);
    }

    async deleteSession(session: ExamSession): Promise<void> {
        if (!session.savedPath) {
            return;
        }

        await this.deleteReport(session.savedPath);
    }

    async deleteHistory(path: string): Promise<void> {
        await this.deleteReport(path);
    }

    private async deleteReport(path: string): Promise<void> {
        const normalizedPath: string = normalizePath(path);
        this.assertExamResultPath(normalizedPath);

        if (await this.adapter.exists(normalizedPath)) {
            await this.adapter.remove(normalizedPath);
        }
    }

    private assertExamResultPath(path: string): void {
        if (!this.isExamResultPath(path)) {
            throw new Error(this.t("exam.notice.invalidHistoryPath"));
        }
    }

    private async ensureResultsDirectory(): Promise<void> {
        const hiddenDirPath: string = normalizePath(VAULT_COACH_HIDDEN_DIR_PATH);
        const examDirPath: string = normalizePath(EXAM_RESULTS_DIR_PATH);

        if (!(await this.adapter.exists(hiddenDirPath))) {
            await this.adapter.mkdir(hiddenDirPath);
        }

        if (!(await this.adapter.exists(examDirPath))) {
            await this.adapter.mkdir(examDirPath);
        }
    }

    private async ensureExportFolder(targetFolderPath: string): Promise<string> {
        const normalizedFolderPath: string = normalizePath(targetFolderPath.trim()).replace(/\/$/, "");
        if (normalizedFolderPath.length === 0 || normalizedFolderPath === "/") {
            return "";
        }

        await this.ensureFolderPath(normalizedFolderPath);
        return normalizedFolderPath;
    }

    private async ensureFolderPath(folderPath: string): Promise<void> {
        const parts: string[] = normalizePath(folderPath)
            .split("/")
            .map((part: string) => part.trim())
            .filter((part: string) => part.length > 0);

        let currentPath = "";
        for (const part of parts) {
            currentPath = currentPath.length === 0 ? part : `${currentPath}/${part}`;
            const stat: Stat | null = await this.adapter.stat(currentPath);
            if (stat?.type === "file") {
                throw new Error(this.t("exam.notice.exportPathIsFile"));
            }

            if (!stat) {
                await this.adapter.mkdir(currentPath);
            }
        }
    }

    private createResultPath(session: ExamSession): string {
        const safeTitle: string = this.sanitizeFileName(session.title || this.t("exam.defaultTitle"));
        return normalizePath(`${EXAM_RESULTS_DIR_PATH}/${session.id}-${safeTitle}.md`);
    }

    private async createUniqueResultPath(folderPath: string, session: ExamSession): Promise<string> {
        const safeTitle: string = this.sanitizeFileName(session.title || this.t("exam.defaultTitle"));
        const basePath: string = normalizePath(folderPath.length > 0
            ? `${folderPath}/${session.id}-${safeTitle}`
            : `${session.id}-${safeTitle}`);

        let candidatePath = `${basePath}.md`;
        let duplicateIndex = 2;
        while (await this.adapter.exists(candidatePath)) {
            candidatePath = `${basePath}-${duplicateIndex}.md`;
            duplicateIndex += 1;
        }

        return candidatePath;
    }

    private sanitizeFileName(value: string): string {
        const sanitizedValue: string = value
            .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60);

        return sanitizedValue.length > 0 ? sanitizedValue : this.t("exam.defaultTitle");
    }

    private isExamResultPath(path: string): boolean {
        const normalizedPath: string = normalizePath(path);
        return normalizedPath.startsWith(`${EXAM_RESULTS_DIR_PATH}/`)
            && normalizedPath.toLowerCase().endsWith(".md");
    }
}
