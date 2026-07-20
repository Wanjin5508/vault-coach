import { App, TFile, normalizePath } from "obsidian";
import {
    isVaultCoachHiddenPath,
    normalizeGraphPath,
    normalizeHeadingPath,
} from "../../domain/graph/graph-id";
import type {
    GraphSourceDocument,
    GraphSourceReference,
    GraphSourceSection,
    GraphSourceTag,
} from "../../domain/graph/graph-types";
import type { DocumentIndexReader } from "../../domain/documents/document-index-reader";
import type {
    DocumentLocator,
    IndexedChunk,
    KnowledgeBaseFileRecord,
    KnowledgeDocumentType,
} from "../../domain/documents/document-types";

type GraphSourceDiagnosticCode =
    | "missing-indexed-file"
    | "missing-document-identity"
    | "unresolved-link-target"
    | "outside-index-target";

export interface GraphSourceReadDiagnostic {
    code: GraphSourceDiagnosticCode;
    filePath: string;
    message: string;
    link?: string;
}

export interface GraphSourceReadResult {
    documents: GraphSourceDocument[];
    diagnostics: GraphSourceReadDiagnostic[];
}

interface GraphMetadataCache {
    headings?: unknown;
    links?: unknown;
    embeds?: unknown;
    tags?: unknown;
    frontmatter?: unknown;
}

interface MetadataHeading {
    heading: string;
    level: number;
    startLine: number | undefined;
}

interface MetadataReference {
    link: string;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
}

interface IndexedGraphDocument {
    record: KnowledgeBaseFileRecord;
    documentId: string;
    documentType: KnowledgeDocumentType;
    chunks: IndexedChunk[];
}

/**
 * Converts live Obsidian metadata and the current document index into pure graph
 * source facts. It does not construct graph nodes, write files, or invoke a model.
 */
export class ObsidianGraphSourceReader {
    constructor(
        private readonly app: App,
        private readonly documentIndex: DocumentIndexReader,
    ) {}

    readAll(): GraphSourceReadResult {
        return this.readPaths(this.getIndexedDocuments().map((document) => document.record.filePath));
    }

    readPaths(filePaths: readonly string[]): GraphSourceReadResult {
        const diagnostics: GraphSourceReadDiagnostic[] = [];
        const indexedDocumentsByPath = new Map<string, IndexedGraphDocument>(
            this.getIndexedDocuments().map((document) => [normalizeGraphPath(document.record.filePath), document]),
        );
        const requestedPaths = Array.from(new Set(filePaths.map(normalizeGraphPath)))
            .filter((path) => path.length > 0)
            .sort(compareStrings);
        const documents: GraphSourceDocument[] = [];

        for (const filePath of requestedPaths) {
            const indexedDocument = indexedDocumentsByPath.get(filePath);
            if (!indexedDocument) continue;
            const document = this.readDocument(indexedDocument, indexedDocumentsByPath, diagnostics);
            if (document) documents.push(document);
        }

        return {
            documents: documents.sort((left, right) => compareStrings(left.filePath, right.filePath)),
            diagnostics: diagnostics.sort(compareDiagnostics),
        };
    }

    private getIndexedDocuments(): IndexedGraphDocument[] {
        const documents: IndexedGraphDocument[] = [];
        for (const record of this.documentIndex.getFileRecords()) {
            const filePath = normalizeGraphPath(record.filePath);
            if (filePath.length === 0 || isVaultCoachHiddenPath(filePath)) continue;

            const chunks = this.documentIndex.getChunksByFilePath(record.filePath)
                .filter((chunk) => normalizeGraphPath(chunk.filePath) === filePath)
                .sort((left, right) => compareStrings(left.id, right.id));
            const firstChunk = chunks[0];
            const documentId = record.documentId ?? firstChunk?.documentId;
            const documentType = record.documentType ?? firstChunk?.documentType;
            if (!documentId || !documentType) continue;

            documents.push({ record, documentId, documentType, chunks });
        }

        return documents.sort((left, right) => compareStrings(left.record.filePath, right.record.filePath));
    }

    private readDocument(
        indexedDocument: IndexedGraphDocument,
        indexedDocumentsByPath: ReadonlyMap<string, IndexedGraphDocument>,
        diagnostics: GraphSourceReadDiagnostic[],
    ): GraphSourceDocument | null {
        const filePath = normalizeGraphPath(indexedDocument.record.filePath);
        const abstractFile = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
        if (!(abstractFile instanceof TFile)) {
            diagnostics.push({
                code: "missing-indexed-file",
                filePath,
                message: `Indexed graph source file is unavailable in the Vault: ${filePath}.`,
            });
            return null;
        }

        const cache = this.app.metadataCache.getFileCache(abstractFile) as GraphMetadataCache | null;
        return {
            documentId: indexedDocument.documentId,
            filePath,
            documentType: indexedDocument.documentType,
            title: abstractFile.basename,
            contentHash: indexedDocument.record.contentHash,
            modifiedAt: indexedDocument.record.modifiedTime ?? abstractFile.stat.mtime ?? null,
            sections: this.createSections(abstractFile, indexedDocument, cache),
            links: this.createReferences(
                abstractFile,
                cache,
                "links",
                indexedDocumentsByPath,
                diagnostics,
            ),
            embeds: this.createReferences(
                abstractFile,
                cache,
                "embeds",
                indexedDocumentsByPath,
                diagnostics,
            ),
            tags: this.createTags(cache),
        };
    }

    private createSections(
        file: TFile,
        indexedDocument: IndexedGraphDocument,
        cache: GraphMetadataCache | null,
    ): GraphSourceSection[] {
        if (indexedDocument.documentType === "markdown") {
            return this.createMarkdownSections(file, indexedDocument.chunks, cache);
        }

        return this.createChunkSections(indexedDocument.chunks);
    }

    private createMarkdownSections(
        file: TFile,
        chunks: readonly IndexedChunk[],
        cache: GraphMetadataCache | null,
    ): GraphSourceSection[] {
        const headings = this.getMetadataHeadings(cache);
        const rootChunkIds = chunks
            .filter((chunk) => normalizeHeadingPath(chunk.headingPath).length === 0)
            .map((chunk) => chunk.id)
            .sort(compareStrings);
        const sections: GraphSourceSection[] = rootChunkIds.length > 0
            ? [{
                headingPath: [],
                occurrence: 0,
                chunkIds: rootChunkIds,
                locator: { type: "markdown", filePath: file.path },
            }]
            : [];

        if (headings.length === 0) {
            return this.sortSections([
                ...sections,
                ...this.createSectionsFromChunkHeadingPaths(file, chunks),
            ]);
        }

        const headingOccurrences = new Map<string, number>();
        const headingPathCounts = new Map<string, number>();
        const headingPaths = this.buildHeadingPaths(headings);
        for (const headingPath of headingPaths) {
            const key = headingPath.join("\u0000");
            headingPathCounts.set(key, (headingPathCounts.get(key) ?? 0) + 1);
        }

        for (const headingPath of headingPaths) {
            const key = headingPath.join("\u0000");
            const occurrence = headingOccurrences.get(key) ?? 0;
            headingOccurrences.set(key, occurrence + 1);
            const chunkIds = headingPathCounts.get(key) === 1
                ? this.getChunkIdsForHeadingPath(chunks, headingPath)
                : [];
            sections.push({
                headingPath,
                occurrence,
                chunkIds,
                locator: {
                    type: "markdown",
                    filePath: file.path,
                    heading: headingPath[headingPath.length - 1],
                },
            });
        }

        return this.sortSections(sections);
    }

    private createSectionsFromChunkHeadingPaths(file: TFile, chunks: readonly IndexedChunk[]): GraphSourceSection[] {
        const chunkIdsByHeadingPath = new Map<string, string[]>();
        for (const chunk of chunks) {
            const headingPath = normalizeHeadingPath(chunk.headingPath);
            if (headingPath.length === 0) continue;
            const key = headingPath.join("\u0000");
            const chunkIds = chunkIdsByHeadingPath.get(key) ?? [];
            chunkIds.push(chunk.id);
            chunkIdsByHeadingPath.set(key, chunkIds);
        }

        return Array.from(chunkIdsByHeadingPath.entries()).map(([key, chunkIds]) => {
            const headingPath = key.split("\u0000");
            return {
                headingPath,
                occurrence: 0,
                chunkIds: Array.from(new Set(chunkIds)).sort(compareStrings),
                locator: {
                    type: "markdown",
                    filePath: file.path,
                    heading: headingPath[headingPath.length - 1],
                },
            };
        });
    }

    private createChunkSections(chunks: readonly IndexedChunk[]): GraphSourceSection[] {
        const sectionsByKey = new Map<string, GraphSourceSection>();
        for (const chunk of chunks) {
            const headingPath = normalizeHeadingPath(chunk.headingPath);
            const fallbackHeadingPath = headingPath.length > 0
                ? headingPath
                : this.createFallbackHeadingPath(chunk.locator);
            const locator = cloneLocator(chunk.locator);
            const locatorKey = JSON.stringify(locator);
            const key = `${fallbackHeadingPath.join("\u0000")}\u0001${locatorKey}`;
            const existing = sectionsByKey.get(key);
            if (existing) {
                existing.chunkIds.push(chunk.id);
                continue;
            }
            sectionsByKey.set(key, {
                headingPath: fallbackHeadingPath,
                occurrence: 0,
                chunkIds: [chunk.id],
                locator,
            });
        }

        const occurrenceByHeadingPath = new Map<string, number>();
        return this.sortSections(Array.from(sectionsByKey.values()).map((section) => {
            const key = section.headingPath.join("\u0000");
            const occurrence = occurrenceByHeadingPath.get(key) ?? 0;
            occurrenceByHeadingPath.set(key, occurrence + 1);
            return {
                ...section,
                occurrence,
                chunkIds: Array.from(new Set(section.chunkIds)).sort(compareStrings),
            };
        }));
    }

    private createFallbackHeadingPath(locator: DocumentLocator): string[] {
        if (locator.type === "pdf") return [`Page ${locator.pageStart}`];
        if (locator.type === "zotero") return [locator.citationKey ?? locator.itemKey];
        return [];
    }

    private getMetadataHeadings(cache: GraphMetadataCache | null): MetadataHeading[] {
        if (!Array.isArray(cache?.headings)) return [];
        return cache.headings
            .map((heading: unknown) => this.toMetadataHeading(heading))
            .filter((heading: MetadataHeading | null): heading is MetadataHeading => heading !== null)
            .sort((left, right) => (left.startLine ?? Number.MAX_SAFE_INTEGER) - (right.startLine ?? Number.MAX_SAFE_INTEGER)
                || compareStrings(left.heading, right.heading));
    }

    private toMetadataHeading(value: unknown): MetadataHeading | null {
        if (!isRecord(value) || typeof value.heading !== "string" || !isPositiveInteger(value.level)) {
            return null;
        }
        const heading = normalizeHeadingPath([value.heading])[0];
        if (!heading) return null;
        return {
            heading,
            level: Math.min(value.level, 6),
            startLine: getPosition(value.position).startLine,
        };
    }

    private buildHeadingPaths(headings: readonly MetadataHeading[]): string[][] {
        const hierarchy: Array<string | undefined> = [];
        const headingPaths: string[][] = [];
        for (const heading of headings) {
            hierarchy.length = Math.max(heading.level - 1, 0);
            hierarchy[heading.level - 1] = heading.heading;
            headingPaths.push(hierarchy.filter((value: string | undefined): value is string => value !== undefined));
        }

        return headingPaths;
    }

    private getChunkIdsForHeadingPath(chunks: readonly IndexedChunk[], headingPath: readonly string[]): string[] {
        const targetKey = normalizeHeadingPath(headingPath).join("\u0000");
        return chunks
            .filter((chunk) => normalizeHeadingPath(chunk.headingPath).join("\u0000") === targetKey)
            .map((chunk) => chunk.id)
            .sort(compareStrings);
    }

    private createReferences(
        file: TFile,
        cache: GraphMetadataCache | null,
        field: "links" | "embeds",
        indexedDocumentsByPath: ReadonlyMap<string, IndexedGraphDocument>,
        diagnostics: GraphSourceReadDiagnostic[],
    ): GraphSourceReference[] {
        const cachedReferences = Array.isArray(cache?.[field])
            ? cache[field]
                .map((reference: unknown) => this.toMetadataReference(reference))
                .filter((reference: MetadataReference | null): reference is MetadataReference => reference !== null)
            : null;
        const references: GraphSourceReference[] = [];
        if (cachedReferences !== null) {
            for (const reference of cachedReferences) {
                const targetFilePath = this.resolveReferenceTarget(
                    reference.link,
                    file,
                    indexedDocumentsByPath,
                    diagnostics,
                );
                if (!targetFilePath) continue;
                references.push({
                    targetFilePath,
                    chunkIds: [],
                    ...(reference.startLine === undefined ? {} : { startLine: reference.startLine }),
                    ...(reference.startColumn === undefined ? {} : { startColumn: reference.startColumn }),
                    ...(reference.endLine === undefined ? {} : { endLine: reference.endLine }),
                    ...(reference.endColumn === undefined ? {} : { endColumn: reference.endColumn }),
                });
            }
        } else if (field === "links") {
            const resolvedLinks = this.app.metadataCache.resolvedLinks[file.path] ?? {};
            for (const targetPath of Object.keys(resolvedLinks).sort(compareStrings)) {
                const normalizedTargetPath = normalizeGraphPath(targetPath);
                if (indexedDocumentsByPath.has(normalizedTargetPath)) {
                    references.push({ targetFilePath: normalizedTargetPath, chunkIds: [] });
                } else {
                    diagnostics.push({
                        code: "outside-index-target",
                        filePath: file.path,
                        message: `Resolved link target is not part of the current document index: ${normalizedTargetPath}.`,
                        link: targetPath,
                    });
                }
            }
        }

        return dedupeAndSortReferences(references);
    }

    private toMetadataReference(value: unknown): MetadataReference | null {
        if (!isRecord(value) || typeof value.link !== "string" || value.link.trim().length === 0) {
            return null;
        }
        const position = getPosition(value.position);
        return {
            link: value.link.trim(),
            ...position,
        };
    }

    private resolveReferenceTarget(
        link: string,
        sourceFile: TFile,
        indexedDocumentsByPath: ReadonlyMap<string, IndexedGraphDocument>,
        diagnostics: GraphSourceReadDiagnostic[],
    ): string | null {
        const target = this.app.metadataCache.getFirstLinkpathDest(link, sourceFile.path);
        if (!target) {
            diagnostics.push({
                code: "unresolved-link-target",
                filePath: sourceFile.path,
                message: `Obsidian could not resolve graph source link: ${link}.`,
                link,
            });
            return null;
        }

        const targetFilePath = normalizeGraphPath(target.path);
        if (!indexedDocumentsByPath.has(targetFilePath) || isVaultCoachHiddenPath(targetFilePath)) {
            diagnostics.push({
                code: "outside-index-target",
                filePath: sourceFile.path,
                message: `Resolved link target is not part of the current document index: ${targetFilePath}.`,
                link,
            });
            return null;
        }

        return targetFilePath;
    }

    private createTags(cache: GraphMetadataCache | null): GraphSourceTag[] {
        const tags: GraphSourceTag[] = [];
        if (Array.isArray(cache?.tags)) {
            for (const candidate of cache.tags) {
                if (!isRecord(candidate) || typeof candidate.tag !== "string" || candidate.tag.trim().length === 0) continue;
                const position = getPosition(candidate.position);
                tags.push({
                    rawName: candidate.tag.trim().normalize("NFC"),
                    chunkIds: [],
                    ...position,
                });
            }
        }

        for (const tag of getFrontmatterTags(cache?.frontmatter)) {
            tags.push({ rawName: tag, chunkIds: [] });
        }

        return dedupeAndSortTags(tags);
    }

    private sortSections(sections: readonly GraphSourceSection[]): GraphSourceSection[] {
        return sections
            .map((section) => ({
                ...section,
                headingPath: [...section.headingPath],
                chunkIds: Array.from(new Set(section.chunkIds)).sort(compareStrings),
                locator: cloneLocator(section.locator),
            }))
            .sort((left, right) => compareStrings(left.headingPath.join("\u0000"), right.headingPath.join("\u0000"))
                || left.occurrence - right.occurrence
                || compareStrings(JSON.stringify(left.locator), JSON.stringify(right.locator)));
    }
}

function dedupeAndSortReferences(references: readonly GraphSourceReference[]): GraphSourceReference[] {
    const referencesByKey = new Map<string, GraphSourceReference>();
    for (const reference of references) {
        const normalizedReference: GraphSourceReference = {
            ...reference,
            targetFilePath: normalizeGraphPath(reference.targetFilePath),
            chunkIds: Array.from(new Set(reference.chunkIds)).sort(compareStrings),
        };
        referencesByKey.set(JSON.stringify(normalizedReference), normalizedReference);
    }

    return Array.from(referencesByKey.values())
        .sort(compareReferences);
}

function dedupeAndSortTags(tags: readonly GraphSourceTag[]): GraphSourceTag[] {
    const tagsByKey = new Map<string, GraphSourceTag>();
    for (const tag of tags) {
        const normalizedTag: GraphSourceTag = {
            ...tag,
            rawName: tag.rawName.trim().normalize("NFC"),
            chunkIds: Array.from(new Set(tag.chunkIds)).sort(compareStrings),
        };
        if (normalizedTag.rawName.length > 0) tagsByKey.set(JSON.stringify(normalizedTag), normalizedTag);
    }

    return Array.from(tagsByKey.values())
        .sort(compareTags);
}

function compareReferences(left: GraphSourceReference, right: GraphSourceReference): number {
    return compareStrings(left.targetFilePath, right.targetFilePath)
        || compareOptionalNumber(left.startLine, right.startLine)
        || compareOptionalNumber(left.startColumn, right.startColumn)
        || compareOptionalNumber(left.endLine, right.endLine)
        || compareOptionalNumber(left.endColumn, right.endColumn)
        || compareStrings(JSON.stringify(left.chunkIds), JSON.stringify(right.chunkIds));
}

function compareTags(left: GraphSourceTag, right: GraphSourceTag): number {
    return compareStrings(left.rawName, right.rawName)
        || compareOptionalNumber(left.startLine, right.startLine)
        || compareOptionalNumber(left.startColumn, right.startColumn)
        || compareOptionalNumber(left.endLine, right.endLine)
        || compareOptionalNumber(left.endColumn, right.endColumn)
        || compareStrings(JSON.stringify(left.chunkIds), JSON.stringify(right.chunkIds));
}

function getFrontmatterTags(frontmatter: unknown): string[] {
    if (!isRecord(frontmatter)) return [];
    const tags = frontmatter.tags;
    if (typeof tags === "string") return [tags.trim()].filter((tag) => tag.length > 0);
    if (!Array.isArray(tags)) return [];
    return tags
        .filter((tag: unknown): tag is string => typeof tag === "string")
        .map((tag: string) => tag.trim())
        .filter((tag: string) => tag.length > 0);
}

function getPosition(value: unknown): Pick<GraphSourceReference, "startLine" | "startColumn" | "endLine" | "endColumn"> {
    if (!isRecord(value)) return {};
    const start = isRecord(value.start) ? value.start : null;
    const end = isRecord(value.end) ? value.end : null;
    return {
        ...(isNonNegativeInteger(start?.line) ? { startLine: start.line } : {}),
        ...(isNonNegativeInteger(start?.col) ? { startColumn: start.col } : {}),
        ...(isNonNegativeInteger(end?.line) ? { endLine: end.line } : {}),
        ...(isNonNegativeInteger(end?.col) ? { endColumn: end.col } : {}),
    };
}

function cloneLocator(locator: DocumentLocator): DocumentLocator {
    return { ...locator };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function compareStrings(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
    if (left === right) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left - right;
}

function compareDiagnostics(left: GraphSourceReadDiagnostic, right: GraphSourceReadDiagnostic): number {
    return compareStrings(left.filePath, right.filePath)
        || compareStrings(left.code, right.code)
        || compareStrings(left.link ?? "", right.link ?? "");
}
