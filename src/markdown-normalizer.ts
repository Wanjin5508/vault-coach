export function normalizeObsidianMarkdown(markdown: string): string {
    return normalizeDisplayMathBlocks(markdown);
}

function normalizeDisplayMathBlocks(markdown: string): string {
    const lines: string[] = markdown.split("\n");
    const normalizedLines: string[] = [];
    let index = 0;
    let inFence = false;
    let fenceMarker: string | null = null;

    while (index < lines.length) {
        const line: string = lines[index] ?? "";
        const fenceMatch: RegExpMatchArray | null = line.match(/^\s*(```+|~~~+)/);
        if (fenceMatch) {
            const marker: string = fenceMatch[1] ?? "";
            if (!inFence) {
                inFence = true;
                fenceMarker = marker.startsWith("`") ? "`" : "~";
            } else if (fenceMarker && marker.startsWith(fenceMarker)) {
                inFence = false;
                fenceMarker = null;
            }
            normalizedLines.push(line);
            index += 1;
            continue;
        }

        if (inFence) {
            normalizedLines.push(line);
            index += 1;
            continue;
        }

        const openMath: MathBracket | null = getMathBracketLine(line, "open");
        if (!openMath) {
            normalizedLines.push(line);
            index += 1;
            continue;
        }

        const closeIndex: number = findMathBracketClose(lines, index + 1, openMath.indent);
        if (closeIndex === -1) {
            normalizedLines.push(line);
            index += 1;
            continue;
        }

        const mathLines: string[] = lines.slice(index + 1, closeIndex);
        if (!looksLikeLatexBlock(mathLines)) {
            normalizedLines.push(line);
            index += 1;
            continue;
        }

        normalizedLines.push(`${openMath.indent}$$`);
        normalizedLines.push(...mathLines.map((mathLine: string) => stripCommonIndent(mathLine, openMath.indent)));
        normalizedLines.push(`${openMath.indent}$$`);
        index = closeIndex + 1;
    }

    return normalizedLines.join("\n");
}

interface MathBracket {
    indent: string;
}

function getMathBracketLine(line: string, type: "open" | "close"): MathBracket | null {
    const match: RegExpMatchArray | null = line.match(/^(\s*)(\\?\[|\\?\])\s*$/);
    if (!match) {
        return null;
    }

    const bracket: string | undefined = match[2];
    if ((type === "open" && bracket !== "[" && bracket !== "\\[")
        || (type === "close" && bracket !== "]" && bracket !== "\\]")) {
        return null;
    }

    return {
        indent: match[1] ?? "",
    };
}

function findMathBracketClose(lines: string[], startIndex: number, indent: string): number {
    for (let index = startIndex; index < lines.length; index += 1) {
        const line: string = lines[index] ?? "";
        const closeMath: MathBracket | null = getMathBracketLine(line, "close");
        if (closeMath && closeMath.indent === indent) {
            return index;
        }

        if (line.trim().length === 0) {
            continue;
        }

        if (isLikelyMarkdownBlockBoundary(line)) {
            return -1;
        }
    }

    return -1;
}

function looksLikeLatexBlock(lines: string[]): boolean {
    const content: string = lines.join("\n").trim();
    if (content.length === 0 || content.includes("$$")) {
        return false;
    }

    return /\\(?:frac|sqrt|text|left|right|sum|int|prod|lim|begin|end|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega)\b/.test(content)
        || /[_^][A-Za-z0-9{}]/.test(content);
}

function isLikelyMarkdownBlockBoundary(line: string): boolean {
    return /^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/.test(line.trim());
}

function stripCommonIndent(line: string, indent: string): string {
    return indent.length > 0 && line.startsWith(indent) ? line.slice(indent.length) : line;
}
