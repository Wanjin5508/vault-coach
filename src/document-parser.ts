import { TFile, normalizePath } from "obsidian";
import type {
    DocumentParseContext,
    KnowledgeDocumentType,
    ParsedDocument,
} from "./types";

export interface DocumentParser {
    supports(file: TFile): boolean;
    parse(file: TFile, context: DocumentParseContext): Promise<ParsedDocument>;
}

export class DocumentParserRegistry {
    private readonly parsers: DocumentParser[];

    constructor(parsers: DocumentParser[]) {
        this.parsers = parsers;
    }

    resolve(file: TFile): DocumentParser | null {
        return this.parsers.find((parser: DocumentParser) => parser.supports(file)) ?? null;
    }
}

export function createDocumentId(documentType: KnowledgeDocumentType, filePath: string): string {
    return `${documentType}:${normalizePath(filePath)}`;
}

export function hashString(content: string): string {
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
        hash ^= content.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return `${content.length}:${(hash >>> 0).toString(16)}`;
}

export function hashArrayBuffer(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hash = 2166136261;
    for (let index = 0; index < bytes.length; index += 1) {
        hash ^= bytes[index] ?? 0;
        hash = Math.imul(hash, 16777619);
    }

    return `${bytes.length}:${(hash >>> 0).toString(16)}`;
}
