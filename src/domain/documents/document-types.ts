/** Types owned by the document and index domain. */

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

export interface KnowledgeBaseSyncResult {
    stats: KnowledgeBaseStats;
    changedChunks: IndexedChunk[];
    removedChunkIds: string[];
    affectedFiles: string[];
}
