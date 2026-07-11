import { App, TFile } from "obsidian";
import * as pdfjsLib from "pdfjs-dist";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.js";
import { createDocumentId, hashArrayBuffer, type DocumentParser } from "./document-parser";
import type {
    DocumentParseContext,
    ParsedDocument,
    ParsedDocumentBlock,
    PdfExtractionReport,
    VaultCoachSettings,
} from "./types";

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

const PDF_PARSER_VERSION = "pdf-native-text-parser-v1";
const LOW_TEXT_PAGE_CHARACTER_THRESHOLD = 40;

const globalScopeWithPdfJsWorker = globalThis as typeof globalThis & {
    pdfjsWorker?: unknown;
};

if (!globalScopeWithPdfJsWorker.pdfjsWorker) {
    globalScopeWithPdfJsWorker.pdfjsWorker = pdfjsWorker;
}

export class PdfDocumentParser implements DocumentParser {
    private readonly app: App;
    private readonly getSettings: () => VaultCoachSettings;

    constructor(app: App, getSettings: () => VaultCoachSettings) {
        this.app = app;
        this.getSettings = getSettings;
    }

    supports(file: TFile): boolean {
        return file.extension.toLowerCase() === "pdf";
    }

    async parse(file: TFile, context: DocumentParseContext): Promise<ParsedDocument> {
        context.signal?.throwIfAborted();

        const settings: VaultCoachSettings = this.getSettings();
        const maxBytes: number = Math.max(1, settings.maxPdfFileSizeMb) * 1024 * 1024;
        if (file.stat.size > maxBytes) {
            throw new Error(`PDF exceeds configured size limit: ${file.path}`);
        }

        const buffer: ArrayBuffer = await this.app.vault.readBinary(file);
        const contentHash: string = hashArrayBuffer(buffer);
        const loadingTask = pdfjsLib.getDocument({
            data: new Uint8Array(buffer.slice(0)),
            disableFontFace: true,
            stopAtErrors: false,
            useSystemFonts: true,
            useWorkerFetch: false,
            verbosity: pdfjsLib.VerbosityLevel.ERRORS,
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
                    disableCombineTextItems: false,
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
            await loadingTask.destroy();
        }
    }

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

    private readTransformNumber(transform: unknown[], index: number): number {
        const value: unknown = transform[index];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    }

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

    private looksLikeStandaloneHeading(line: TextLine): boolean {
        const text: string = line.text.trim();
        return text.length > 0
            && text.length < 120
            && !/[。.!?！？]$/.test(text)
            && line.width < 420;
    }

    private isPageNumberOnly(text: string): boolean {
        return /^\s*(?:page\s*)?\d+\s*$/i.test(text);
    }

    private normalizeStructuralLine(text: string): string {
        return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    }

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
