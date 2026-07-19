import type { Stat } from "obsidian";
import type { TranslationKey } from "../i18n";
import type { ExamEvaluationItem, ExamHistoryItem, ExamQuestion, ExamSession } from "../domain/exam/exam-types";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

export function formatExamSessionMarkdown(session: ExamSession, t: TranslateFn): string {
    const lines: string[] = [
        "---",
        "vaultCoachExam: true",
        `examId: ${JSON.stringify(session.id)}`,
        `createdAt: ${session.createdAt}`,
        `score: ${session.evaluation?.score ?? ""}`,
        `maxScore: ${session.evaluation?.maxScore ?? ""}`,
        `scope: ${JSON.stringify(session.scopeLabel)}`,
        "---",
        "",
        `# ${session.title}`,
        "",
        `- ${t("exam.markdown.id")}：${session.id}`,
        `- ${t("exam.markdown.createdAt")}：${formatDateTime(session.createdAt)}`,
        `- ${t("exam.markdown.scope")}：${session.scopeLabel}`,
        `- ${t("exam.markdown.questionCount")}：${session.questions.length}`,
    ];

    if (session.evaluation) {
        lines.push(`- ${t("exam.markdown.score")}：${session.evaluation.score} / ${session.evaluation.maxScore}`);
        lines.push("");
        lines.push(`## ${t("exam.markdown.overallFeedback")}`);
        lines.push("");
        lines.push(session.evaluation.overallFeedback);
    }

    lines.push("");
    lines.push(`## ${t("exam.markdown.questions")}`);

    session.questions.forEach((question: ExamQuestion, index: number) => {
        const answer: string = session.userAnswers[index]?.trim() ?? "";
        const evaluationItem: ExamEvaluationItem | undefined = session.evaluation?.items.find((item: ExamEvaluationItem) => {
            return item.questionId === question.id;
        });

        lines.push("");
        lines.push(`### ${index + 1}. ${question.question}`);
        lines.push("");
        lines.push(`#### ${t("exam.markdown.userAnswer")}`);
        lines.push("");
        lines.push(answer.length > 0 ? answer : t("exam.unanswered"));
        lines.push("");
        lines.push(`#### ${t("exam.markdown.referenceAnswer")}`);
        lines.push("");
        lines.push(question.referenceAnswer);
        lines.push("");
        lines.push(`#### ${t("exam.markdown.rubric")}`);
        lines.push("");
        lines.push(question.rubric);

        if (evaluationItem) {
            lines.push("");
            lines.push(`#### ${t("exam.markdown.evaluation")}`);
            lines.push("");
            lines.push(`- ${t("exam.markdown.score")}：${evaluationItem.score} / ${evaluationItem.maxScore}`);
            lines.push(`- ${t("exam.markdown.feedback")}：${evaluationItem.feedback}`);
            lines.push(`- ${t("exam.markdown.improvement")}：${evaluationItem.improvement}`);
        }

        if (question.sourcePaths.length > 0) {
            lines.push("");
            lines.push(`#### ${t("exam.markdown.sources")}`);
            lines.push("");
            for (const sourcePath of question.sourcePaths) {
                lines.push(`- [[${sourcePath}]]`);
            }
        }
    });

    lines.push("");
    return lines.join("\n");
}

export function parseExamHistoryItem(path: string, content: string, stat: Stat | null, t: TranslateFn): ExamHistoryItem {
    const title: string = parseFirstMarkdownHeading(content) || sanitizeHistoryTitle(path, t);
    const createdAt: number | null = parseNumberMetadata(content, "createdAt")
        ?? parseCreatedAtFromMarkdown(content);
    const score: number | null = parseNumberMetadata(content, "score")
        ?? parseScoreFromMarkdown(content, 0);
    const maxScore: number | null = parseNumberMetadata(content, "maxScore")
        ?? parseScoreFromMarkdown(content, 1);

    return {
        path,
        title,
        createdAt,
        score,
        maxScore,
        modifiedAt: stat?.mtime ?? null,
    };
}

function formatDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

function parseFirstMarkdownHeading(content: string): string | null {
    const match: RegExpExecArray | null = /^#\s+(.+)$/m.exec(content);
    return match?.[1]?.trim() ?? null;
}

function sanitizeHistoryTitle(path: string, t: TranslateFn): string {
    const fileName: string = path.split("/").pop() ?? t("exam.defaultTitle");
    return fileName.replace(/\.md$/i, "");
}

function parseNumberMetadata(content: string, key: string): number | null {
    const match: RegExpExecArray | null = new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m").exec(content);
    if (!match?.[1]) {
        return null;
    }

    const parsedValue: number = Number.parseInt(match[1], 10);
    return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseCreatedAtFromMarkdown(content: string): number | null {
    const match: RegExpExecArray | null = /创建时间[：:]\s*(.+)$/m.exec(content)
        ?? /Created at[：:]\s*(.+)$/m.exec(content);
    const rawDate: string | undefined = match?.[1]?.trim();
    if (!rawDate) {
        return null;
    }

    const timestamp: number = Date.parse(rawDate);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function parseScoreFromMarkdown(content: string, index: 0 | 1): number | null {
    const match: RegExpExecArray | null = /(?:得分|Score)[：:]\s*(\d+)\s*\/\s*(\d+)/m.exec(content);
    const rawValue: string | undefined = match?.[index + 1];
    if (!rawValue) {
        return null;
    }

    const parsedValue: number = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsedValue) ? parsedValue : null;
}
