import { App } from "obsidian";
import type { AssessmentSessionDocumentV1 } from "../domain/assessment/assessment-types";
import type { TranslationKey } from "../i18n";
import type { ExamHistoryItem, ExamSession } from "../domain/exam/exam-types";
import { MarkdownExamReportStore } from "../infrastructure/storage/markdown-exam-report-store";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/**
 * Backward-compatible application facade for Markdown exam reports.
 * Assessment JSON remains separate and will be composed by the next step.
 */
export class ExamSessionStore {
    private readonly reports: MarkdownExamReportStore;

    constructor(
        app: App,
        t: TranslateFn,
    ) {
        this.reports = new MarkdownExamReportStore(app.vault.adapter, t);
    }

    prepareSessionForSave(session: ExamSession): ExamSession {
        return this.reports.prepareSessionForSave(session);
    }

    async save(session: ExamSession): Promise<ExamSession> {
        return this.reports.save(session);
    }

    async writeAssessmentProjection(
        document: AssessmentSessionDocumentV1,
        assessmentSessionPath: string,
    ): Promise<ExamSession> {
        return this.reports.writeAssessmentProjection(document, assessmentSessionPath);
    }

    async export(session: ExamSession, targetFolderPath: string): Promise<string> {
        return this.reports.export(session, targetFolderPath);
    }

    async listHistory(): Promise<ExamHistoryItem[]> {
        return this.reports.listHistory();
    }

    async readHistoryContent(path: string): Promise<string> {
        return this.reports.readHistoryContent(path);
    }

    async deleteSession(session: ExamSession): Promise<void> {
        return this.reports.deleteSession(session);
    }

    async deleteHistory(path: string): Promise<void> {
        return this.reports.deleteHistory(path);
    }
}
