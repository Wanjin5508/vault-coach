/**
 * Markdown 输出归一化模块。
 *
 * 负责把模型返回的 Markdown 调整为 Obsidian/MarkdownRenderer 更容易正确渲染的格式。
 * 当前重点处理模型常见的 LaTeX display/inline math 包裹方式。
 */

/**
 * 对即将展示到 Obsidian 的 Markdown 做兼容性归一化。
 */
export function normalizeObsidianMarkdown(markdown: string): string {
    return normalizeInlineMath(normalizeDisplayMathBlocks(markdown));
}

/**
 * 将模型偶尔输出的独立 `[` / `]` 或 `\[` / `\]` 数学块转换为 Obsidian 支持的 `$$` 数学块。
 *
 * 函数会跳过代码围栏内部内容，避免误改代码示例。
 */
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

/**
 * 将模型常见的 `\(...\)` 行内公式转换为 Obsidian 支持的 `$...$`。
 *
 * 函数会跳过代码围栏和行内代码，避免修改代码示例中的转义括号。
 */
function normalizeInlineMath(markdown: string): string {
    const lines: string[] = markdown.split("\n");
    const normalizedLines: string[] = [];
    let inFence = false;
    let fenceMarker: string | null = null;

    for (const line of lines) {
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
            continue;
        }

        normalizedLines.push(inFence ? line : normalizeInlineMathInLine(line));
    }

    return normalizedLines.join("\n");
}

/**
 * 处理单行中的行内公式，同时保留行内代码原样。
 */
function normalizeInlineMathInLine(line: string): string {
    let output = "";
    let index = 0;

    while (index < line.length) {
        if (line[index] === "`") {
            const backtickCount: number = countBackticks(line, index);
            const codeSpanEnd: number = findClosingBackticks(line, index + backtickCount, backtickCount);
            if (codeSpanEnd === -1) {
                output += line.slice(index);
                break;
            }

            output += line.slice(index, codeSpanEnd + backtickCount);
            index = codeSpanEnd + backtickCount;
            continue;
        }

        if (line[index] === "\\" && line[index + 1] === "(") {
            const closeIndex: number = findInlineMathClose(line, index + 2);
            if (closeIndex !== -1) {
                const content: string = line.slice(index + 2, closeIndex);
                if (shouldNormalizeInlineMathContent(content)) {
                    output += `$${content.trim()}$`;
                    index = closeIndex + 2;
                    continue;
                }
            }
        }

        output += line[index] ?? "";
        index += 1;
    }

    return output;
}

/**
 * 统计当前位置连续反引号数量，用于匹配 Markdown 行内代码边界。
 */
function countBackticks(line: string, startIndex: number): number {
    let count = 0;
    while (line[startIndex + count] === "`") {
        count += 1;
    }

    return count;
}

/**
 * 查找与当前行内代码起始边界长度一致的结束边界。
 */
function findClosingBackticks(line: string, startIndex: number, backtickCount: number): number {
    return line.indexOf("`".repeat(backtickCount), startIndex);
}

/**
 * 查找 `\(...\)` 的结束边界。
 */
function findInlineMathClose(line: string, startIndex: number): number {
    for (let index = startIndex; index < line.length - 1; index += 1) {
        if (line[index] === "\\" && line[index + 1] === ")") {
            return index;
        }
    }

    return -1;
}

/**
 * 判断行内公式内容是否适合转换为 `$...$`。
 */
function shouldNormalizeInlineMathContent(content: string): boolean {
    const trimmedContent: string = content.trim();
    return trimmedContent.length > 0 && !trimmedContent.includes("$");
}

/**
 * 数学块边界行的信息。
 */
interface MathBracket {
    indent: string;
}

/**
 * 判断一行是否是 display math 的开/闭边界。
 */
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

/**
 * 从起始行向后寻找同缩进的数学块结束边界。
 */
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

/**
 * 判断候选内容是否像 LaTeX 公式，而不是普通 Markdown 方括号文本。
 */
function looksLikeLatexBlock(lines: string[]): boolean {
    const content: string = lines.join("\n").trim();
    if (content.length === 0 || content.includes("$$")) {
        return false;
    }

    return /\\(?:frac|sqrt|text|left|right|sum|int|prod|lim|begin|end|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega)\b/.test(content)
        || /[_^][A-Za-z0-9{}]/.test(content);
}

/**
 * 判断是否遇到新的 Markdown 块边界。
 *
 * 用于在数学块闭合符缺失时及时放弃转换，避免吞掉后续正文。
 */
function isLikelyMarkdownBlockBoundary(line: string): boolean {
    return /^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/.test(line.trim());
}

/**
 * 移除与数学块边界一致的公共缩进，让转换后的 `$$` 块内部保持原始排版。
 */
function stripCommonIndent(line: string, indent: string): string {
    return indent.length > 0 && line.startsWith(indent) ? line.slice(indent.length) : line;
}
