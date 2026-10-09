import { normalizePath, type ListedFiles, type Stat } from "obsidian";
import { EXAM_RESULTS_DIR_PATH, VAULT_COACH_HIDDEN_DIR_PATH } from "../../constants";
import type { AssessmentSessionDocumentV1 } from "../../domain/assessment/assessment-types";
import type { ExamHistoryItem, ExamSession } from "../../domain/exam/exam-types";
import type { TranslationKey } from "../../i18n";
import {
    formatAssessmentSessionMarkdown,
    formatExamSessionMarkdown,
    parseExamHistoryItem,
    parseExamHistorySessionId,
} from "../../exam/exam-session-markdown";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/** 已解析的 Markdown 历史记录；可选 ID 用于跨来源去重。 */
export interface MarkdownExamHistoryRecord {
    item: ExamHistoryItem;
    sessionId: string | null;
}

/** Markdown 考试报告所需的最小 Vault 适配器接口。 */
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
 * 只存储考试的可读 Markdown 表示。
 *
 * 本存储不依赖 JSON 事实存储，因此删除报告绝不能删除 Assessment 事件或 Concept 绑定。
 */
export class MarkdownExamReportStore {
    constructor(
        private readonly adapter: MarkdownExamReportStorageAdapter,
        private readonly t: TranslateFn,
    ) {}

    /** 生成稳定报告路径，不执行任何 I/O。 */
    prepareSessionForSave(session: ExamSession): ExamSession {
        return {
            ...session,
            savedPath: session.savedPath ?? this.createResultPath(session),
            status: "saved",
        };
    }

    /** 保存当前应用仍使用的旧版 Markdown 报告格式。 */
    async save(session: ExamSession): Promise<ExamSession> {
        await this.ensureResultsDirectory();

        const savedSession = this.prepareSessionForSave(session);

        await this.adapter.write(savedSession.savedPath!, formatExamSessionMarkdown(savedSession, this.t));
        return savedSession;
    }

    /**
     * 根据不可变 Assessment Session 文档创建或刷新 Markdown 投影。
     * 返回路径仍由调用方负责写回 JSON 事实来源。
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
        const records = await this.listHistoryRecords();
        return records.map((record: MarkdownExamHistoryRecord) => record.item);
    }

    async listHistoryRecords(): Promise<MarkdownExamHistoryRecord[]> {
        await this.ensureResultsDirectory();

        const listedFiles: ListedFiles = await this.adapter.list(EXAM_RESULTS_DIR_PATH);
        const markdownPaths: string[] = listedFiles.files
            .filter((path: string) => path.toLowerCase().endsWith(".md"))
            .sort((leftPath: string, rightPath: string) => rightPath.localeCompare(leftPath));

        const records: MarkdownExamHistoryRecord[] = [];
        for (const path of markdownPaths) {
            try {
                const [content, stat]: [string, Stat | null] = await Promise.all([
                    this.adapter.read(path),
                    this.adapter.stat(path),
                ]);
                records.push({
                    item: parseExamHistoryItem(path, content, stat, this.t),
                    sessionId: parseExamHistorySessionId(content),
                });
            } catch (error: unknown) {
                console.error("[VaultCoach] 读取考试历史失败", error);
            }
        }

        records.sort((left: MarkdownExamHistoryRecord, right: MarkdownExamHistoryRecord) => {
            return (right.item.createdAt ?? right.item.modifiedAt ?? 0) - (left.item.createdAt ?? left.item.modifiedAt ?? 0);
        });
        return records;
    }

    async readHistoryContent(path: string): Promise<string> {
        const normalizedPath: string = normalizePath(path);
        this.assertExamResultPath(normalizedPath);

        return this.adapter.read(normalizedPath);
    }

    /** 读取现有投影；不存在时仅根据结构化事实重建。 */
    async readOrCreateAssessmentProjection(
        document: AssessmentSessionDocumentV1,
        assessmentSessionPath: string,
    ): Promise<string> {
        const preparedSession = this.prepareSessionForSave(document.examSession);
        const reportPath = preparedSession.savedPath!;
        if (await this.adapter.exists(reportPath)) {
            return this.adapter.read(reportPath);
        }

        await this.writeAssessmentProjection(document, assessmentSessionPath);
        return this.adapter.read(reportPath);
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
