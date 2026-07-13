import { App, TFile } from "obsidian";
import { createDocumentId, hashString, type DocumentParser } from "./document-parser";
import type {
    DocumentParseContext,
    ParsedDocument,
    ParsedDocumentBlock,
} from "./types";

/**
 * Markdown 文档解析模块。
 *
 * 将 Obsidian Markdown 文件按标题路径切成语义 section，并包装为统一 ParsedDocument。
 * 后续 chunk 大小切分由 VaultKnowledgeBase 负责，本解析器只处理 Markdown 结构。
 */

/**
 * Markdown 中一个标题路径下的正文片段。
 */
interface MarkdownSection {
    headingPath: string[];
    text: string;
}

export const MARKDOWN_PARSER_VERSION = "markdown-parser-v2";

/**
 * Obsidian Markdown 文件解析器。
 */
export class MarkdownDocumentParser implements DocumentParser {
    private readonly app: App;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * 仅处理 `.md` 文件。
     */
    supports(file: TFile): boolean {
        return file.extension.toLowerCase() === "md";
    }

    /**
     * 读取 Markdown 文件并转换为统一文档结构。
     */
    async parse(file: TFile, context: DocumentParseContext): Promise<ParsedDocument> {
        context.signal?.throwIfAborted();

        const content: string = await this.app.vault.cachedRead(file);
        const sections: MarkdownSection[] = this.parseMarkdownSections(content);
        const blocks: ParsedDocumentBlock[] = sections.map((section: MarkdownSection, index: number) => {
            const primaryHeading: string | undefined = section.headingPath[section.headingPath.length - 1];
            return {
                id: `${file.path}::section::${index}`,
                kind: "paragraph",
                text: section.text,
                headingPath: [...section.headingPath],
                locator: {
                    type: "markdown",
                    filePath: file.path,
                    heading: primaryHeading,
                },
                contentKind: "native-text",
                extractionQuality: 1,
            };
        });

        return {
            documentId: createDocumentId("markdown", file.path),
            documentType: "markdown",
            title: file.basename,
            filePath: file.path,
            metadata: {
                fileSize: file.stat.size,
                modifiedTime: file.stat.mtime,
                contentHash: hashString(content),
                title: file.basename,
            },
            blocks,
            extraction: {
                method: "markdown",
                parserVersion: MARKDOWN_PARSER_VERSION,
                qualityScore: 1,
                warnings: [],
            },
        };
    }

    /**
     * 按 ATX 标题维护 headingPath，并把每段标题下的正文聚合成 section。
     *
     * 该方法不会解析 Markdown AST；保留轻量行扫描以减少插件启动和索引成本。
     */
    private parseMarkdownSections(content: string): MarkdownSection[] {
        const lines: string[] = content.split(/\r?\n/);
        const sections: MarkdownSection[] = [];
        let currentHeadingPath: string[] = [];
        let buffer: string[] = [];

        const flushBuffer = (): void => {
            const text: string = buffer.join("\n").trim();
            if (text.length > 0) {
                sections.push({
                    headingPath: [...currentHeadingPath],
                    text,
                });
            }
            buffer = [];
        };

        for (const rawLine of lines) {
            const headingMatch: RegExpExecArray | null = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/.exec(rawLine);

            if (headingMatch) {
                flushBuffer();

                const hashes: string | undefined = headingMatch[1];
                const rawHeadingText: string | undefined = headingMatch[2];
                if (!hashes || rawHeadingText === undefined) {
                    continue;
                }

                const headingLevel: number = hashes.length;
                const headingText: string = rawHeadingText.trim().replace(/\s+#*\s*$/, "");
                currentHeadingPath = currentHeadingPath.slice(0, Math.max(headingLevel - 1, 0));
                currentHeadingPath[headingLevel - 1] = headingText;
                continue;
            }

            buffer.push(rawLine);
        }

        flushBuffer();
        return sections;
    }
}
