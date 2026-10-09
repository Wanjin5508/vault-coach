import { VAULT_COACH_HIDDEN_DIR_PATH } from "../constants";

/** 在不依赖 Obsidian 运行时 API 的情况下归一化 Vault 相对路径。 */
export function normalizeVaultPath(path: string): string {
    return path
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\/+|\/+$/g, "");
}

/** 判断路径是否属于 Vault Coach 内部运行目录。 */
export function isVaultCoachHiddenPath(path: string): boolean {
    const normalizedPath: string = normalizeVaultPath(path);
    return normalizedPath === VAULT_COACH_HIDDEN_DIR_PATH
        || normalizedPath.startsWith(`${VAULT_COACH_HIDDEN_DIR_PATH}/`);
}

/** 返回 Vault 相对文件路径的全部父目录。 */
export function getParentFolderPaths(filePath: string): string[] {
    const pathParts: string[] = normalizeVaultPath(filePath).split("/");
    pathParts.pop();

    const folderPaths: string[] = [];
    for (let length = 1; length <= pathParts.length; length += 1) {
        const folderPath: string = pathParts.slice(0, length).join("/");
        if (folderPath.length > 0 && !isVaultCoachHiddenPath(folderPath)) {
            folderPaths.push(folderPath);
        }
    }

    return folderPaths;
}

/** 判断文件是否位于指定 Vault 相对目录内。 */
export function isFileInFolder(filePath: string, folderPath: string): boolean {
    const normalizedFolderPath: string = normalizeVaultPath(folderPath);
    if (normalizedFolderPath.length === 0) {
        return true;
    }

    return normalizeVaultPath(filePath).startsWith(`${normalizedFolderPath}/`);
}

/** 返回第一个匹配文件路径的用户排除规则。 */
export function findMatchingExamExcludeRule(filePath: string, configuredPatterns: string): string | null {
    const normalizedPath: string = normalizeVaultPath(filePath);
    const patterns: string[] = configuredPatterns
        .split(/\r?\n/g)
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && !line.startsWith("#"));

    for (const pattern of patterns) {
        const normalizedPattern: string = normalizeVaultPath(pattern.replace(/^\/+/, ""));
        if (matchesExamExcludePattern(normalizedPath, normalizedPattern)) {
            return pattern;
        }
    }

    return null;
}

/** 判断文件路径是否匹配简化的 Vault 相对 glob。 */
export function matchesExamExcludePattern(filePath: string, pattern: string): boolean {
    if (pattern.length === 0) {
        return false;
    }

    if (!pattern.includes("*") && !pattern.includes("?")) {
        return filePath === pattern || filePath.startsWith(`${pattern}/`);
    }

    const doubleStarPlaceholder = "__VAULT_COACH_DOUBLE_STAR__";
    const escapedPattern: string = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, doubleStarPlaceholder)
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(new RegExp(doubleStarPlaceholder, "g"), ".*");
    return new RegExp(`^${escapedPattern}$`).test(filePath);
}

/** 检查笔记是否包含可用正文前，移除非正文 Markdown 语法。 */
export function cleanExamMarkdownText(markdown: string): string {
    return markdown
        .replace(/^---[\s\S]*?---\s*/m, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/~~~[\s\S]*?~~~/g, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
        .replace(/[`*_~>#-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * 为未来调用方保留的确定性内容质量分类。
 * 当前范围继续保持旧版仅按阈值排除的行为。
 */
export function detectLowQualityExamContentReason(rawText: string, cleanedText: string): string | null {
    const contentLines: string[] = cleanedText
        .split(/\r?\n/g)
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0);
    const rawLines: string[] = rawText
        .split(/\r?\n/g)
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0);

    if (contentLines.length === 0) {
        return "Empty or heading-only note";
    }

    const checkboxLineCount: number = rawLines.filter((line: string) => /^[-*+]\s+\[[ xX]\]/.test(line)).length;
    const linkOnlyLineCount: number = rawLines.filter((line: string) => {
        const withoutLinks: string = line
            .replace(/\[\[[^\]]+\]\]/g, "")
            .replace(/\[[^\]]+\]\([^)]+\)/g, "")
            .replace(/^[-*+]\s+/, "")
            .trim();
        return withoutLinks.length <= 8 && (/\[\[[^\]]+\]\]/.test(line) || /\[[^\]]+\]\([^)]+\)/.test(line));
    }).length;
    const substantialParagraphCount: number = contentLines.filter((line: string) => {
        return line.length >= 24
            && !/^[-*+]\s+\[[ xX]\]/.test(line)
            && !/^[-*+]\s+\S+$/.test(line)
            && !/^#{1,6}\s+/.test(line);
    }).length;

    if (checkboxLineCount >= Math.max(3, Math.ceil(contentLines.length * 0.6)) && substantialParagraphCount <= 1) {
        return "Task-list dominant content";
    }

    if (linkOnlyLineCount >= Math.max(3, Math.ceil(contentLines.length * 0.6)) && substantialParagraphCount <= 1) {
        return "Link-index dominant content";
    }

    const commandOrLogLineCount: number = rawLines.filter((line: string) => {
        return /^(\$|>|npm |pnpm |yarn |cargo |go |python |Traceback|Error:|at\s+\S+\()/.test(line);
    }).length;
    if (commandOrLogLineCount >= Math.max(5, Math.ceil(rawLines.length * 0.6)) && substantialParagraphCount <= 1) {
        return "Raw command or log output";
    }

    return null;
}
