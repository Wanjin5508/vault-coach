import { TFile, normalizePath } from "obsidian";
import type {
    DocumentParseContext,
    KnowledgeDocumentType,
    ParsedDocument,
} from "./domain/documents/document-types";

/**
 * 文档解析模块。
 *
 * 将 Markdown、PDF 等不同来源统一转换为 ParsedDocument，供知识库索引层统一切块。
 * 新增文档类型时应实现 DocumentParser，并注册到 DocumentParserRegistry。
 */

/**
 * 单个文档解析器的统一接口。
 *
 * supports 用于做文件类型匹配，parse 负责读取文件并输出统一文档结构。
 */
export interface DocumentParser {
    supports(file: TFile): boolean;
    parse(file: TFile, context: DocumentParseContext): Promise<ParsedDocument>;
}

/**
 * 文档解析器注册表。
 *
 * 通过按顺序匹配 supports 的方式选择解析器，让知识库层不需要关心具体文件类型。
 */
export class DocumentParserRegistry {
    private readonly parsers: DocumentParser[];

    constructor(parsers: DocumentParser[]) {
        this.parsers = parsers;
    }

    /**
     * 为指定文件寻找第一个可用解析器。
     */
    resolve(file: TFile): DocumentParser | null {
        return this.parsers.find((parser: DocumentParser) => parser.supports(file)) ?? null;
    }
}

/**
 * 生成跨文档类型稳定的文档 ID。
 *
 * ID 同时包含文档类型和 vault 相对路径，避免未来接入 Zotero、PDF 等来源时发生冲突。
 */
export function createDocumentId(documentType: KnowledgeDocumentType, filePath: string): string {
    return `${documentType}:${normalizePath(filePath)}`;
}

/**
 * 为文本内容生成轻量哈希。
 *
 * 当前使用 FNV-1a 风格哈希并附带长度，用于判断 Markdown 内容是否发生变化。
 */
export function hashString(content: string): string {
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
        hash ^= content.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return `${content.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * 为二进制内容生成轻量哈希。
 *
 * PDF 等二进制文件无法直接使用 cachedRead，因此通过 ArrayBuffer 计算内容指纹。
 */
export function hashArrayBuffer(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hash = 2166136261;
    for (let index = 0; index < bytes.length; index += 1) {
        hash ^= bytes[index] ?? 0;
        hash = Math.imul(hash, 16777619);
    }

    return `${bytes.length}:${(hash >>> 0).toString(16)}`;
}
