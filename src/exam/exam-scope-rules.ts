import { VAULT_COACH_HIDDEN_DIR_PATH } from "../constants";

/** Normalize a vault-relative path without relying on Obsidian runtime APIs. */
export function normalizeVaultPath(path: string): string {
    return path
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\/+|\/+$/g, "");
}

/** Whether a path belongs to VaultCoach's internal runtime directory. */
export function isVaultCoachHiddenPath(path: string): boolean {
    const normalizedPath: string = normalizeVaultPath(path);
    return normalizedPath === VAULT_COACH_HIDDEN_DIR_PATH
        || normalizedPath.startsWith(`${VAULT_COACH_HIDDEN_DIR_PATH}/`);
}

/** Returns every parent directory of a vault-relative file path. */
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

/** Whether a file is inside the requested vault-relative folder. */
export function isFileInFolder(filePath: string, folderPath: string): boolean {
    const normalizedFolderPath: string = normalizeVaultPath(folderPath);
    if (normalizedFolderPath.length === 0) {
        return true;
    }

    return normalizeVaultPath(filePath).startsWith(`${normalizedFolderPath}/`);
}

/** Find the first user-configured exclude pattern that matches a file path. */
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

/** Determine whether a file path matches a simple vault-relative glob. */
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

/** Strip non-body Markdown syntax before checking whether a note has usable text. */
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
 * Deterministic content-quality classification retained for future callers.
 * The current scope preserves the legacy threshold-only exclusion behavior.
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
