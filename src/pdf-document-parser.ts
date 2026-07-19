import { App, TFile } from "obsidian";
import { createDocumentId, hashArrayBuffer, type DocumentParser } from "./document-parser";
import type {
    DocumentParseContext,
    ParsedDocument,
    ParsedDocumentBlock,
    PdfExtractionReport,
} from "./domain/documents/document-types";
import type { VaultCoachSettings } from "./app/config/settings-types";

/**
 * PDF 文档解析模块。
 *
 * 通过 pdf.js 提取文本层，恢复阅读顺序，过滤重复页眉页脚，并输出统一 ParsedDocument。
 * 当前仅支持文本型 PDF；扫描件会通过质量报告标记为低覆盖率，暂不做 OCR。
 */

type PdfJsLib = typeof import("pdfjs-dist");
type PdfJsWorker = typeof import("pdfjs-dist/build/pdf.worker.mjs");
type PdfJsWorkerInstance = InstanceType<PdfJsLib["PDFWorker"]>;
type PdfJsLibModule = PdfJsLib | Promise<PdfJsLib> | {
    default?: PdfJsLib | Promise<PdfJsLib>;
    pdfjsLibPromise?: Promise<PdfJsLib>;
};
type PdfJsWorkerModule = PdfJsWorker | { default?: PdfJsWorker };
type PdfWorkerFactory = {
    new(params: { port?: null }): PdfJsWorkerInstance;
    fromPort?: (params: { port: Worker }) => PdfJsWorkerInstance;
};

type PdfTextItem = {
    str: string;
    transform: unknown[];
    width: number;
    height: number;
    hasEOL: boolean;
};

interface ExtractedTextItem {
    text: string;
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
    hasEol: boolean;
}

interface TextLine {
    pageNumber: number;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
}

interface TextParagraph {
    pageNumber: number;
    text: string;
    fontSize: number;
    y: number;
}

interface PageExtraction {
    pageNumber: number;
    paragraphs: TextParagraph[];
    characterCount: number;
    likelyMultiColumn: boolean;
}

const PDF_PARSER_VERSION = "pdf-native-text-parser-v2";
const LOW_TEXT_PAGE_CHARACTER_THRESHOLD = 40;

interface PromiseCapability<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

interface PromiseConstructorWithResolvers extends PromiseConstructor {
    withResolvers?: <T>() => PromiseCapability<T>;
}

interface LoadedPdfJs {
    pdfjsLib: PdfJsLib;
    pdfjsWorker: PdfJsWorker;
}

type PdfJsMessageListener = (event: MessageEvent<unknown>) => void;

/**
 * pdf.js worker 的同线程回环端口。
 *
 * Obsidian 插件环境下直接启动 worker 可能受打包和 CSP 影响；这里用 loopback port
 * 让 pdf.js 的 worker message handler 在同线程内工作，保持 API 行为一致。
 */
class PdfJsLoopbackPort {
    onmessage: PdfJsMessageListener | null = null;
    private readonly listeners: Set<PdfJsMessageListener> = new Set<PdfJsMessageListener>();
    private deferred: Promise<void> = Promise.resolve();

    /**
     * 模拟 Worker.postMessage，并按顺序异步派发 message 事件。
     */
    postMessage(message: unknown, transfer?: Transferable[]): void {
        const event = {
            data: clonePdfJsMessage(message, transfer),
        } as MessageEvent<unknown>;

        this.deferred = this.deferred.then(() => {
            this.onmessage?.(event);
            for (const listener of this.listeners) {
                listener.call(this, event);
            }
        });
    }

    /**
     * 注册 pdf.js 需要的 message 事件监听器。
     */
    addEventListener(name: "message", listener: PdfJsMessageListener): void {
        if (name === "message") {
            this.listeners.add(listener);
        }
    }

    /**
     * 移除 message 事件监听器。
     */
    removeEventListener(name: "message", listener: PdfJsMessageListener): void {
        if (name === "message") {
            this.listeners.delete(listener);
        }
    }

    /**
     * 清理所有监听器。
     */
    terminate(): void {
        this.listeners.clear();
        this.onmessage = null;
    }
}

let pdfJsLoadPromise: Promise<LoadedPdfJs> | null = null;

/**
 * PDF 文件解析器。
 */
export class PdfDocumentParser implements DocumentParser {
    private readonly app: App;
    private readonly getSettings: () => VaultCoachSettings;

    constructor(app: App, getSettings: () => VaultCoachSettings) {
        this.app = app;
        this.getSettings = getSettings;
    }

    /**
     * 仅处理 `.pdf` 文件。
     */
    supports(file: TFile): boolean {
        return file.extension.toLowerCase() === "pdf";
    }

    /**
     * 读取 PDF 二进制内容并提取结构化文本块。
     *
     * 解析过程会遵守文件大小、页数上限和 AbortSignal，避免长时间阻塞插件。
     */
    async parse(file: TFile, context: DocumentParseContext): Promise<ParsedDocument> {
        context.signal?.throwIfAborted();

        const settings: VaultCoachSettings = this.getSettings();
        const maxBytes: number = Math.max(1, settings.maxPdfFileSizeMb) * 1024 * 1024;
        if (file.stat.size > maxBytes) {
            throw new Error(`PDF exceeds configured size limit: ${file.path}`);
        }

        const buffer: ArrayBuffer = await this.app.vault.readBinary(file);
        const contentHash: string = hashArrayBuffer(buffer);
        const { pdfjsLib, pdfjsWorker }: LoadedPdfJs = await loadPdfJs();
        const pdfWorker: PdfJsWorkerInstance = createPdfWorker(pdfjsLib, pdfjsWorker);
        const loadingTask = pdfjsLib.getDocument({
            data: new Uint8Array(buffer.slice(0)),
            disableFontFace: true,
            stopAtErrors: false,
            useSystemFonts: true,
            useWorkerFetch: false,
            isEvalSupported: false,
            worker: pdfWorker,
        });

        try {
            const pdfDocument = await loadingTask.promise;
            const totalPages: number = pdfDocument.numPages;
            if (totalPages > Math.max(1, settings.maxPdfPageCount)) {
                throw new Error(`PDF exceeds configured page limit: ${file.path}`);
            }

            const pageExtractions: PageExtraction[] = [];
            const allLinesByPage: TextLine[][] = [];

            for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
                context.signal?.throwIfAborted();
                context.onProgress?.({
                    filePath: file.path,
                    current: pageNumber,
                    total: totalPages,
                    label: "Extracting PDF text",
                });

                const page = await pdfDocument.getPage(pageNumber);
                const textContent = await page.getTextContent({
                    includeMarkedContent: false,
                });
                const pdfTextItems: PdfTextItem[] = [];
                for (const item of textContent.items) {
                    if (this.isPdfTextItem(item)) {
                        pdfTextItems.push(item);
                    }
                }
                const items: ExtractedTextItem[] = pdfTextItems
                    .map((item: PdfTextItem) => this.toExtractedTextItem(item, pageNumber))
                    .filter((item: ExtractedTextItem) => item.text.trim().length > 0);
                const lines: TextLine[] = this.buildLines(items);
                allLinesByPage.push(lines);
            }

            const repeatedLineTexts: Set<string> = this.detectRepeatedHeaderFooterLines(allLinesByPage);

            for (let index = 0; index < allLinesByPage.length; index += 1) {
                const lines: TextLine[] | undefined = allLinesByPage[index];
                if (!lines) {
                    continue;
                }

                const cleanedLines: TextLine[] = lines.filter((line: TextLine) => {
                    return !repeatedLineTexts.has(this.normalizeStructuralLine(line.text));
                });
                const orderedLines: TextLine[] = this.restoreReadingOrder(cleanedLines);
                const paragraphs: TextParagraph[] = this.buildParagraphs(orderedLines);
                const characterCount: number = paragraphs.reduce((sum: number, paragraph: TextParagraph) => {
                    return sum + paragraph.text.length;
                }, 0);

                pageExtractions.push({
                    pageNumber: index + 1,
                    paragraphs,
                    characterCount,
                    likelyMultiColumn: this.isLikelyMultiColumn(cleanedLines),
                });
            }

            const report: PdfExtractionReport = this.buildExtractionReport(totalPages, pageExtractions);
            const blocks: ParsedDocumentBlock[] = this.buildBlocks(file, pageExtractions, report);

            return {
                documentId: createDocumentId("pdf", file.path),
                documentType: "pdf",
                title: file.basename,
                filePath: file.path,
                metadata: {
                    fileSize: file.stat.size,
                    modifiedTime: file.stat.mtime,
                    contentHash,
                    pageCount: totalPages,
                    title: file.basename,
                    warnings: [...report.warnings],
                },
                blocks,
                extraction: {
                    method: "pdf-native-text",
                    parserVersion: PDF_PARSER_VERSION,
                    qualityScore: report.qualityScore,
                    warnings: [...report.warnings],
                },
            };
        } finally {
            try {
                await loadingTask.destroy();
            } finally {
                pdfWorker.destroy();
            }
        }
    }

    /**
     * 判断 pdf.js 返回项是否是可用文本项。
     */
    private isPdfTextItem(value: unknown): value is PdfTextItem {
        if (!value || typeof value !== "object") {
            return false;
        }

        const record = value as Record<string, unknown>;
        return typeof record.str === "string"
            && Array.isArray(record.transform)
            && typeof record.width === "number"
            && typeof record.height === "number";
    }

    /**
     * 将 pdf.js 文本项转换为带页面和坐标信息的内部结构。
     */
    private toExtractedTextItem(item: PdfTextItem, pageNumber: number): ExtractedTextItem {
        const x: number = this.readTransformNumber(item.transform, 4);
        const y: number = this.readTransformNumber(item.transform, 5);
        const scaleX: number = this.readTransformNumber(item.transform, 0);
        const skewY: number = this.readTransformNumber(item.transform, 1);
        const fontSize: number = Math.max(1, Math.hypot(scaleX, skewY) || item.height || 1);

        return {
            text: item.str.replace(/\s+/g, " ").trim(),
            pageNumber,
            x,
            y,
            width: item.width,
            height: item.height,
            fontSize,
            hasEol: item.hasEOL,
        };
    }

    /**
     * 从 PDF transform 数组中安全读取数值。
     */
    private readTransformNumber(transform: unknown[], index: number): number {
        const value: unknown = transform[index];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    }

    /**
     * 按坐标把文本项聚合成行。
     */
    private buildLines(items: ExtractedTextItem[]): TextLine[] {
        const sortedItems: ExtractedTextItem[] = [...items].sort((left: ExtractedTextItem, right: ExtractedTextItem) => {
            const yDelta: number = right.y - left.y;
            return Math.abs(yDelta) > 2 ? yDelta : left.x - right.x;
        });
        const lineBuckets: ExtractedTextItem[][] = [];

        for (const item of sortedItems) {
            const existingBucket: ExtractedTextItem[] | undefined = lineBuckets.find((bucket: ExtractedTextItem[]) => {
                const firstItem: ExtractedTextItem | undefined = bucket[0];
                if (!firstItem) {
                    return false;
                }
                return Math.abs(firstItem.y - item.y) <= Math.max(2, item.fontSize * 0.45);
            });

            if (existingBucket) {
                existingBucket.push(item);
            } else {
                lineBuckets.push([item]);
            }
        }

        return lineBuckets.map((bucket: ExtractedTextItem[]) => {
            const sortedBucket: ExtractedTextItem[] = [...bucket].sort((left: ExtractedTextItem, right: ExtractedTextItem) => left.x - right.x);
            const text: string = this.joinLineItems(sortedBucket);
            const minX: number = Math.min(...sortedBucket.map((item: ExtractedTextItem) => item.x));
            const maxX: number = Math.max(...sortedBucket.map((item: ExtractedTextItem) => item.x + item.width));
            const averageY: number = sortedBucket.reduce((sum: number, item: ExtractedTextItem) => sum + item.y, 0) / sortedBucket.length;
            const averageFontSize: number = sortedBucket.reduce((sum: number, item: ExtractedTextItem) => sum + item.fontSize, 0) / sortedBucket.length;
            const maxHeight: number = Math.max(...sortedBucket.map((item: ExtractedTextItem) => item.height || item.fontSize));

            return {
                pageNumber: sortedBucket[0]?.pageNumber ?? 1,
                text,
                x: minX,
                y: averageY,
                width: maxX - minX,
                height: maxHeight,
                fontSize: averageFontSize,
            };
        }).filter((line: TextLine) => line.text.length > 0);
    }

    /**
     * 拼接同一行内的文本项，并根据横向间距补空格。
     */
    private joinLineItems(items: ExtractedTextItem[]): string {
        let text = "";
        let previousItem: ExtractedTextItem | null = null;

        for (const item of items) {
            if (previousItem) {
                const gap: number = item.x - (previousItem.x + previousItem.width);
                if (gap > Math.max(1.5, item.fontSize * 0.22)) {
                    text += " ";
                }
            }

            text += item.text;
            previousItem = item;
        }

        return text.replace(/\s+/g, " ").trim();
    }

    /**
     * 检测跨页面重复出现的页眉/页脚文本。
     */
    private detectRepeatedHeaderFooterLines(linesByPage: TextLine[][]): Set<string> {
        const counts: Map<string, number> = new Map<string, number>();
        for (const lines of linesByPage) {
            const sortedLines: TextLine[] = [...lines].sort((left: TextLine, right: TextLine) => right.y - left.y);
            const edgeLines: TextLine[] = [...sortedLines.slice(0, 2), ...sortedLines.slice(-2)];
            const seenOnPage: Set<string> = new Set<string>();

            for (const line of edgeLines) {
                const normalizedLine: string = this.normalizeStructuralLine(line.text);
                if (normalizedLine.length <= 2 || /^\d+$/.test(normalizedLine)) {
                    continue;
                }
                seenOnPage.add(normalizedLine);
            }

            for (const lineText of seenOnPage) {
                counts.set(lineText, (counts.get(lineText) ?? 0) + 1);
            }
        }

        const threshold: number = Math.max(3, Math.ceil(linesByPage.length * 0.6));
        return new Set(
            Array.from(counts.entries())
                .filter(([, count]: [string, number]) => count >= threshold)
                .map(([lineText]: [string, number]) => lineText),
        );
    }

    /**
     * 恢复页面阅读顺序。
     *
     * 单栏页面按从上到下、从左到右排序；疑似双栏页面先输出跨栏标题，再输出左栏和右栏。
     */
    private restoreReadingOrder(lines: TextLine[]): TextLine[] {
        if (!this.isLikelyMultiColumn(lines)) {
            return [...lines].sort((left: TextLine, right: TextLine) => {
                const yDelta: number = right.y - left.y;
                return Math.abs(yDelta) > Math.max(left.fontSize, right.fontSize) * 0.5 ? yDelta : left.x - right.x;
            });
        }

        const minX: number = Math.min(...lines.map((line: TextLine) => line.x));
        const maxX: number = Math.max(...lines.map((line: TextLine) => line.x + line.width));
        const midpoint: number = minX + (maxX - minX) / 2;
        const fullWidthLines: TextLine[] = [];
        const leftLines: TextLine[] = [];
        const rightLines: TextLine[] = [];

        for (const line of lines) {
            const lineEnd: number = line.x + line.width;
            if (line.x < midpoint * 0.75 && lineEnd > midpoint * 1.12) {
                fullWidthLines.push(line);
            } else if (line.x + line.width / 2 < midpoint) {
                leftLines.push(line);
            } else {
                rightLines.push(line);
            }
        }

        const sortTopDown = (items: TextLine[]): TextLine[] => {
            return [...items].sort((left: TextLine, right: TextLine) => right.y - left.y);
        };

        return [
            ...sortTopDown(fullWidthLines),
            ...sortTopDown(leftLines),
            ...sortTopDown(rightLines),
        ];
    }

    /**
     * 基于左右两侧文本分布估计页面是否为双栏。
     */
    private isLikelyMultiColumn(lines: TextLine[]): boolean {
        if (lines.length < 12) {
            return false;
        }

        const minX: number = Math.min(...lines.map((line: TextLine) => line.x));
        const maxX: number = Math.max(...lines.map((line: TextLine) => line.x + line.width));
        const midpoint: number = minX + (maxX - minX) / 2;
        const leftCount: number = lines.filter((line: TextLine) => line.x + line.width / 2 < midpoint).length;
        const rightCount: number = lines.filter((line: TextLine) => line.x + line.width / 2 >= midpoint).length;
        const medianWidth: number = this.median(lines.map((line: TextLine) => line.width));

        return leftCount >= 5
            && rightCount >= 5
            && medianWidth < (maxX - minX) * 0.72;
    }

    /**
     * 根据垂直间距、缩进和标题特征把文本行合并为段落。
     */
    private buildParagraphs(lines: TextLine[]): TextParagraph[] {
        const paragraphs: TextParagraph[] = [];
        let currentLines: TextLine[] = [];

        const flush = (): void => {
            if (currentLines.length === 0) {
                return;
            }

            const text: string = this.joinParagraphLines(currentLines);
            if (text.length > 0 && !this.isPageNumberOnly(text)) {
                const averageFontSize: number = currentLines.reduce((sum: number, line: TextLine) => sum + line.fontSize, 0) / currentLines.length;
                paragraphs.push({
                    pageNumber: currentLines[0]?.pageNumber ?? 1,
                    text,
                    fontSize: averageFontSize,
                    y: currentLines[0]?.y ?? 0,
                });
            }
            currentLines = [];
        };

        let previousLine: TextLine | null = null;
        for (const line of lines) {
            if (!previousLine) {
                currentLines.push(line);
                previousLine = line;
                continue;
            }

            const verticalGap: number = Math.abs(previousLine.y - line.y);
            const fontReference: number = Math.max(previousLine.fontSize, line.fontSize, 1);
            const startsIndented: boolean = line.x - previousLine.x > fontReference * 1.4;
            const likelyNewParagraph: boolean = verticalGap > fontReference * 1.6 || startsIndented || this.looksLikeStandaloneHeading(previousLine);

            if (likelyNewParagraph) {
                flush();
            }

            currentLines.push(line);
            previousLine = line;
        }

        flush();
        return paragraphs;
    }

    /**
     * 拼接段落内的多行文本，并处理英文断词连字符。
     */
    private joinParagraphLines(lines: TextLine[]): string {
        let text = "";
        for (const line of lines) {
            const lineText: string = line.text.trim();
            if (lineText.length === 0) {
                continue;
            }

            if (text.endsWith("-") && /^[a-z]/.test(lineText)) {
                text = `${text.slice(0, -1)}${lineText}`;
            } else if (text.length > 0) {
                text = `${text} ${lineText}`;
            } else {
                text = lineText;
            }
        }

        return text.replace(/\s+/g, " ").trim();
    }

    /**
     * 汇总 PDF 提取质量报告。
     */
    private buildExtractionReport(totalPages: number, pages: PageExtraction[]): PdfExtractionReport {
        const nativeTextPages: number = pages.filter((page: PageExtraction) => page.characterCount >= LOW_TEXT_PAGE_CHARACTER_THRESHOLD).length;
        const lowTextPages: number = pages.filter((page: PageExtraction) => {
            return page.characterCount > 0 && page.characterCount < LOW_TEXT_PAGE_CHARACTER_THRESHOLD;
        }).length;
        const emptyPages: number = pages.filter((page: PageExtraction) => page.characterCount === 0).length;
        const extractedCharacters: number = pages.reduce((sum: number, page: PageExtraction) => sum + page.characterCount, 0);
        const likelyScanned: boolean = totalPages > 0 && nativeTextPages / totalPages < 0.25;
        const likelyMultiColumn: boolean = pages.some((page: PageExtraction) => page.likelyMultiColumn);
        const warnings: PdfExtractionReport["warnings"] = [];

        if (likelyScanned) {
            warnings.push("likely-scanned");
        }
        if (likelyMultiColumn) {
            warnings.push("layout-order-uncertain");
        }
        if (emptyPages > 0 || lowTextPages > 0) {
            warnings.push("partially-parsed");
        }

        const textCoverage: number = totalPages > 0 ? nativeTextPages / totalPages : 0;
        const qualityScore: number = Math.max(0.05, Math.min(1, textCoverage - (likelyMultiColumn ? 0.12 : 0)));

        return {
            totalPages,
            nativeTextPages,
            lowTextPages,
            emptyPages,
            extractedCharacters,
            averageCharactersPerPage: totalPages > 0 ? Math.round(extractedCharacters / totalPages) : 0,
            likelyScanned,
            likelyMultiColumn,
            qualityScore,
            warnings,
        };
    }

    /**
     * 将页面段落转换为统一 ParsedDocumentBlock。
     */
    private buildBlocks(file: TFile, pages: PageExtraction[], report: PdfExtractionReport): ParsedDocumentBlock[] {
        const blocks: ParsedDocumentBlock[] = [];
        let currentHeadingPath: string[] = [];
        let serial = 0;

        for (const page of pages) {
            const medianFontSize: number = this.median(page.paragraphs.map((paragraph: TextParagraph) => paragraph.fontSize));
            for (const paragraph of page.paragraphs) {
                if (this.looksLikeHeading(paragraph, medianFontSize)) {
                    currentHeadingPath = [paragraph.text];
                    blocks.push({
                        id: `${file.path}::p${page.pageNumber}::heading::${serial}`,
                        kind: "heading",
                        text: paragraph.text,
                        headingPath: [...currentHeadingPath],
                        locator: {
                            type: "pdf",
                            filePath: file.path,
                            pageStart: page.pageNumber,
                            pageEnd: page.pageNumber,
                        },
                        contentKind: "native-text",
                        extractionQuality: report.qualityScore,
                    });
                    serial += 1;
                    continue;
                }

                blocks.push({
                    id: `${file.path}::p${page.pageNumber}::paragraph::${serial}`,
                    kind: "paragraph",
                    text: paragraph.text,
                    headingPath: [...currentHeadingPath],
                    locator: {
                        type: "pdf",
                        filePath: file.path,
                        pageStart: page.pageNumber,
                        pageEnd: page.pageNumber,
                    },
                    contentKind: "native-text",
                    extractionQuality: report.qualityScore,
                });
                serial += 1;
            }
        }

        return blocks;
    }

    /**
     * 通过字号、长度和编号模式判断段落是否像标题。
     */
    private looksLikeHeading(paragraph: TextParagraph, medianFontSize: number): boolean {
        const text: string = paragraph.text.trim();
        if (text.length === 0 || text.length > 160) {
            return false;
        }

        if (/^[\d\s.]+$/.test(text)) {
            return false;
        }

        const hasSentenceEnding: boolean = /[。.!?！？]$/.test(text);
        const numberedHeading: boolean = /^(\d+(\.\d+)*|[IVX]+)\s+/.test(text);
        return numberedHeading || (paragraph.fontSize >= Math.max(1, medianFontSize) * 1.18 && !hasSentenceEnding);
    }

    /**
     * 判断某一行是否像独立标题，用于段落切分。
     */
    private looksLikeStandaloneHeading(line: TextLine): boolean {
        const text: string = line.text.trim();
        return text.length > 0
            && text.length < 120
            && !/[。.!?！？]$/.test(text)
            && line.width < 420;
    }

    /**
     * 过滤只有页码的段落。
     */
    private isPageNumberOnly(text: string): boolean {
        return /^\s*(?:page\s*)?\d+\s*$/i.test(text);
    }

    /**
     * 归一化结构性行文本，用于跨页页眉页脚去重。
     */
    private normalizeStructuralLine(text: string): string {
        return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    }

    /**
     * 计算数值数组中位数。
     */
    private median(values: number[]): number {
        const finiteValues: number[] = values.filter((value: number) => Number.isFinite(value)).sort((left: number, right: number) => left - right);
        if (finiteValues.length === 0) {
            return 1;
        }

        const middle: number = Math.floor(finiteValues.length / 2);
        if (finiteValues.length % 2 === 1) {
            return finiteValues[middle] ?? 1;
        }

        return ((finiteValues[middle - 1] ?? 1) + (finiteValues[middle] ?? 1)) / 2;
    }
}

/**
 * 懒加载 pdf.js 主模块和 worker 模块。
 */
function loadPdfJs(): Promise<LoadedPdfJs> {
    ensurePromiseWithResolvers();

    if (!pdfJsLoadPromise) {
        pdfJsLoadPromise = Promise.all([
            import("pdfjs-dist"),
            import("pdfjs-dist/build/pdf.worker.mjs"),
        ]).then(async ([pdfjsLibModule, pdfjsWorkerModule]: [PdfJsLibModule, PdfJsWorkerModule]) => {
            const pdfjsLib: PdfJsLib = await normalizePdfJsLib(pdfjsLibModule);
            const pdfjsWorker: PdfJsWorker = normalizePdfJsWorker(pdfjsWorkerModule);
            clearPluginPdfWorkerGlobal(pdfjsWorker);
            return {
                pdfjsLib,
                pdfjsWorker,
            };
        }).catch((error: unknown) => {
            pdfJsLoadPromise = null;
            throw error;
        });
    }

    return pdfJsLoadPromise;
}

/**
 * 基于同线程 loopback port 创建 pdf.js worker 实例。
 */
function createPdfWorker(pdfjsLib: PdfJsLib, pdfjsWorker: PdfJsWorker): PdfJsWorkerInstance {
    const port: PdfJsLoopbackPort = new PdfJsLoopbackPort();
    pdfjsWorker.WorkerMessageHandler.initializeFromPort(port);
    const pdfWorkerFactory: PdfWorkerFactory = pdfjsLib.PDFWorker as PdfWorkerFactory;
    try {
        return new pdfWorkerFactory({
            port: port as unknown as null,
        });
    } catch (error: unknown) {
        if (typeof pdfWorkerFactory.fromPort === "function") {
            return pdfWorkerFactory.fromPort({
                port: port as unknown as Worker,
            });
        }

        throw error;
    }
}

/**
 * 兼容不同打包形态下的 pdf.js 主模块导出。
 */
async function normalizePdfJsLib(value: PdfJsLibModule): Promise<PdfJsLib> {
    const resolvedValue: unknown = await Promise.resolve(value);
    if (isPdfJsLib(resolvedValue)) {
        return resolvedValue;
    }

    const defaultValue: unknown = isIndexable(resolvedValue) ? resolvedValue["default"] : undefined;
    const resolvedDefaultValue: unknown = await Promise.resolve(defaultValue);
    if (isPdfJsLib(resolvedDefaultValue)) {
        return resolvedDefaultValue;
    }

    const promiseValue: unknown = isIndexable(resolvedValue) ? resolvedValue["pdfjsLibPromise"] : undefined;
    const resolvedPromiseValue: unknown = await Promise.resolve(promiseValue);
    if (isPdfJsLib(resolvedPromiseValue)) {
        return resolvedPromiseValue;
    }

    throw new Error("Unable to load pdf.js API exports.");
}

/**
 * 兼容不同打包形态下的 pdf.js worker 导出。
 */
function normalizePdfJsWorker(value: PdfJsWorkerModule): PdfJsWorker {
    if (isPdfJsWorker(value)) {
        return value;
    }

    const defaultValue: unknown = isIndexable(value) ? value["default"] : undefined;
    if (isPdfJsWorker(defaultValue)) {
        return defaultValue;
    }

    throw new Error("Unable to load pdf.js worker exports.");
}

/**
 * 判断对象是否包含 pdf.js 主模块所需 API。
 */
function isPdfJsLib(value: unknown): value is PdfJsLib {
    if (!isIndexable(value)) {
        return false;
    }

    return typeof value["getDocument"] === "function"
        && typeof value["PDFWorker"] === "function";
}

/**
 * 判断对象是否包含 pdf.js worker message handler。
 */
function isPdfJsWorker(value: unknown): value is PdfJsWorker {
    if (!isIndexable(value)) {
        return false;
    }

    const workerMessageHandler: unknown = value["WorkerMessageHandler"];
    return isIndexable(workerMessageHandler)
        && typeof workerMessageHandler["initializeFromPort"] === "function";
}

/**
 * 清理 pdf.js worker 在 window 上留下的全局引用。
 *
 * 这样可以避免插件内置 worker 与 Obsidian/其他插件加载的 pdf.js 版本互相污染。
 */
function clearPluginPdfWorkerGlobal(pdfjsWorker: PdfJsWorker): void {
    const windowWithPdfJsWorker = window as Window & {
        pdfjsWorker?: unknown;
    };
    if (
        windowWithPdfJsWorker.pdfjsWorker === pdfjsWorker
        || isPdfJsWorkerVersion(windowWithPdfJsWorker.pdfjsWorker, "4.2.67")
    ) {
        delete windowWithPdfJsWorker.pdfjsWorker;
    }
}

/**
 * 判断 window 上的 worker 是否为指定 pdf.js 版本。
 */
function isPdfJsWorkerVersion(value: unknown, version: string): boolean {
    if (!isIndexable(value)) {
        return false;
    }

    const workerMessageHandler: unknown = value["WorkerMessageHandler"];
    if (!isIndexable(workerMessageHandler)) {
        return false;
    }

    const createDocumentHandler: unknown = workerMessageHandler["createDocumentHandler"];
    return typeof createDocumentHandler === "function"
        && Function.prototype.toString.call(createDocumentHandler).includes(`"${version}"`);
}

/**
 * 判断 unknown 值是否可按对象属性访问。
 */
function isIndexable(value: unknown): value is Record<string, unknown> {
    return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * 克隆 pdf.js worker 消息。
 */
function clonePdfJsMessage(message: unknown, transfer?: Transferable[]): unknown {
    return typeof structuredClone === "function"
        ? structuredClone(message, transfer ? { transfer } : undefined)
        : message;
}

/**
 * 为缺少 Promise.withResolvers 的运行环境补 polyfill。
 *
 * pdf.js 4.x 在部分路径中依赖该 API，而 Obsidian 内嵌运行时不一定提供。
 */
function ensurePromiseWithResolvers(): void {
    const promiseConstructor = Promise as PromiseConstructorWithResolvers;
    if (typeof promiseConstructor.withResolvers === "function") {
        return;
    }

    promiseConstructor.withResolvers = <T>(): PromiseCapability<T> => {
        let resolveCapability: (value: T | PromiseLike<T>) => void = () => undefined;
        let rejectCapability: (reason?: unknown) => void = () => undefined;
        const promise: Promise<T> = new Promise<T>((resolve, reject) => {
            resolveCapability = resolve;
            rejectCapability = reject;
        });

        return {
            promise,
            resolve: resolveCapability,
            reject: rejectCapability,
        };
    };
}
