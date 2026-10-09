/**
 * 文档解析与知识索引之间的领域契约。
 *
 * `ParsedDocument` 保留解析器输出，`IndexedChunk` 是可检索的规范化单元，
 * `KnowledgeBaseFileRecord` 记录增量同步所需的来源指纹。展示层不应依赖解析器内部格式。
 */

export type KnowledgeDocumentType = "markdown" | "pdf" | "zotero";

export type ParsedDocumentBlockKind =
    | "heading"
    | "paragraph"
    | "list"
    | "code"
    | "table"
    | "caption"
    | "ocr-text"
    | "visual-summary";

export type ChunkContentKind =
    | "native-text"
    | "ocr-text"
    | "caption"
    | "visual-summary"
    | "annotation";

export interface MarkdownLocator {
    type: "markdown";
    filePath: string;
    heading?: string;
}

export interface PdfLocator {
    type: "pdf";
    filePath: string;
    pageStart: number;
    pageEnd?: number;
}

export interface ZoteroLocator {
    type: "zotero";
    itemKey: string;
    attachmentKey?: string;
    citationKey?: string;
    pageStart?: number;
    pageEnd?: number;
}

export type DocumentLocator = MarkdownLocator | PdfLocator | ZoteroLocator;

export interface DocumentMetadata {
    fileSize?: number;
    modifiedTime?: number;
    contentHash?: string;
    pageCount?: number;
    title?: string;
    author?: string;
    warnings?: string[];
}

export interface DocumentParseProgress {
    filePath: string;
    current: number;
    total: number;
    label: string;
}

export interface DocumentParseContext {
    signal?: AbortSignal;
    onProgress?: (progress: DocumentParseProgress) => void;
}

export interface ParsedDocumentBlock {
    id: string;
    kind: ParsedDocumentBlockKind;
    text: string;
    headingPath?: string[];
    locator: DocumentLocator;
    contentKind?: ChunkContentKind;
    extractionQuality?: number;
}

/** 单个文档的解析结果；警告允许部分成功，不代表整个文档不可索引。 */
export interface ParsedDocument {
    documentId: string;
    documentType: KnowledgeDocumentType;
    title: string;
    filePath?: string;
    metadata: DocumentMetadata;
    blocks: ParsedDocumentBlock[];
    extraction: {
        method: "markdown" | "pdf-native-text" | "pdf-ocr" | "visual-summary" | "zotero";
        parserVersion: string;
        qualityScore?: number;
        warnings: string[];
    };
}

export interface PdfExtractionReport {
    totalPages: number;
    nativeTextPages: number;
    lowTextPages: number;
    emptyPages: number;
    extractedCharacters: number;
    averageCharactersPerPage: number;
    likelyScanned: boolean;
    likelyMultiColumn: boolean;
    qualityScore: number;
    warnings: Array<
        | "likely-scanned"
        | "layout-order-uncertain"
        | "font-mapping-error"
        | "encrypted"
        | "partially-parsed"
        | "unsupported-content"
    >;
}

/**
 * 检索和引用使用的最小索引单元。
 * `id` 必须在相同来源和分块配置下保持稳定，`searchableText` 可以包含规范化后的检索文本。
 */
export interface IndexedChunk {
    id: string;
    documentId: string;
    documentType: KnowledgeDocumentType;
    filePath: string;
    fileName: string;
    headingPath: string[];
    primaryHeading?: string;
    text: string;
    searchableText: string;
    locator: DocumentLocator;
    contentKind: ChunkContentKind;
    extractionQuality?: number;
}

/** 增量索引的来源记录；`chunkIds` 是替换或删除旧 chunk 的依据。 */
export interface KnowledgeBaseFileRecord {
    documentId?: string;
    documentType?: KnowledgeDocumentType;
    filePath: string;
    contentHash: string;
    fileSize?: number;
    modifiedTime?: number;
    parserVersion?: string;
    chunkerVersion?: string;
    extractionQuality?: number;
    chunkIds: string[];
    indexedAt: number;
}

export interface KnowledgeBaseStats {
    fileCount: number;
    chunkCount: number;
    lastIndexedAt: number | null;
    scopeDescription: string;
}

/** 一次增量同步的结果；`affectedFiles` 是下游图和语义任务的失效依据。 */
export interface KnowledgeBaseSyncResult {
    stats: KnowledgeBaseStats;
    changedChunks: IndexedChunk[];
    removedChunkIds: string[];
    affectedFiles: string[];
}

/** 文档索引产生的关键词检索结果。 */
export interface KeywordSearchHit {
    chunk: IndexedChunk;
    score: number;
    matchedTokens: string[];
}
