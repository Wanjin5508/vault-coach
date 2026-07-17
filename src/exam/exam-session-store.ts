import { App, normalizePath, type ListedFiles, type Stat } from "obsidian";
import { EXAM_RESULTS_DIR_PATH, VAULT_COACH_HIDDEN_DIR_PATH } from "../constants";
import type { TranslationKey } from "../i18n";
import type { ExamHistoryItem, ExamSession } from "../types";
import { formatExamSessionMarkdown, parseExamHistoryItem } from "./exam-session-markdown";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/**
 * 负责考试结果的 vault 文件存储、导出、历史读取和路径校验。
 */
export class ExamSessionStore {
    constructor(
        private readonly app: App,
        private readonly t: TranslateFn,
    ) {}

    async save(session: ExamSession): Promise<ExamSession> {
        await this.ensureResultsDirectory();

        const savedPath: string = session.savedPath ?? this.createResultPath(session);
        const savedSession: ExamSession = {
            ...session,
            savedPath,
            status: "saved",
        };

        await this.app.vault.adapter.write(savedPath, formatExamSessionMarkdown(savedSession, this.t));
        return savedSession;
    }

    async export(session: ExamSession, targetFolderPath: string): Promise<string> {
        const normalizedFolderPath: string = await this.ensureExportFolder(targetFolderPath);
        const exportPath: string = await this.createUniqueResultPath(normalizedFolderPath, session);
        await this.app.vault.adapter.write(exportPath, formatExamSessionMarkdown(session, this.t));
        return exportPath;
    }

    async listHistory(): Promise<ExamHistoryItem[]> {
        await this.ensureResultsDirectory();

        const listedFiles: ListedFiles = await this.app.vault.adapter.list(EXAM_RESULTS_DIR_PATH);
        const markdownPaths: string[] = listedFiles.files
            .filter((path: string) => path.toLowerCase().endsWith(".md"))
            .sort((leftPath: string, rightPath: string) => rightPath.localeCompare(leftPath));

        const items: ExamHistoryItem[] = [];
        for (const path of markdownPaths) {
            try {
                const [content, stat]: [string, Stat | null] = await Promise.all([
                    this.app.vault.adapter.read(path),
                    this.app.vault.adapter.stat(path),
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

        return this.app.vault.adapter.read(normalizedPath);
    }

    async deleteSession(session: ExamSession): Promise<void> {
        if (!session.savedPath) {
            return;
        }

        const savedPath: string = normalizePath(session.savedPath);
        if (await this.app.vault.adapter.exists(savedPath)) {
            await this.app.vault.adapter.remove(savedPath);
        }
    }

    async deleteHistory(path: string): Promise<void> {
        const normalizedPath: string = normalizePath(path);
        this.assertExamResultPath(normalizedPath);

        if (await this.app.vault.adapter.exists(normalizedPath)) {
            await this.app.vault.adapter.remove(normalizedPath);
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

        if (!(await this.app.vault.adapter.exists(hiddenDirPath))) {
            await this.app.vault.adapter.mkdir(hiddenDirPath);
        }

        if (!(await this.app.vault.adapter.exists(examDirPath))) {
            await this.app.vault.adapter.mkdir(examDirPath);
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
            const stat: Stat | null = await this.app.vault.adapter.stat(currentPath);
            if (stat?.type === "file") {
                throw new Error(this.t("exam.notice.exportPathIsFile"));
            }

            if (!stat) {
                await this.app.vault.adapter.mkdir(currentPath);
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
        while (await this.app.vault.adapter.exists(candidatePath)) {
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
