import {
    createDocumentNodeId,
    createGraphEdgeId,
    createSectionNodeId,
    createTagNodeId,
    isVaultCoachHiddenPath,
    normalizeGraphPath,
    normalizeGraphTagName,
    normalizeHeadingPath,
    sortGraphEdges,
    sortGraphNodes,
} from "./graph-id";
import { GraphIntegrityService } from "./graph-integrity-service";
import { GRAPH_SNAPSHOT_SCHEMA_VERSION } from "./graph-types";
import type {
    DocumentGraphNode,
    GraphEdgeOrigin,
    GraphSourceDocument,
    GraphSourceLocation,
    GraphSourceReference,
    GraphSourceSection,
    GraphSourceTag,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    GraphSnapshotV1,
    SectionGraphNode,
    TagGraphNode,
    DeterministicKnowledgeEdgeType,
} from "./graph-types";
import type { DocumentLocator } from "../documents/document-types";

const CONTAINS_CONFIDENCE = 0.9;
const LINK_CONFIDENCE = 0.95;
const EMBED_CONFIDENCE = 0.9;
const TAG_CONFIDENCE = 0.8;

interface NormalizedGraphSourceDocument {
    document: DocumentGraphNode;
    sections: SectionGraphNode[];
    links: GraphSourceReference[];
    embeds: GraphSourceReference[];
    tags: GraphSourceTag[];
}

/** Nodes and edges contributed by one or more source files during an incremental update. */
export interface GraphBuildFragment {
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
}

interface SourcePosition {
    chunkIds: readonly string[];
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
}

/** Reports a source contract violation before an invalid graph can be persisted. */
export class GraphBuildError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GraphBuildError";
    }
}

/**
 * Builds structural Vault facts from Obsidian-free source documents.
 *
 * The builder has no host, filesystem, clock, or model dependency. Its result
 * is sorted and integrity-checked before it is returned to the application layer.
 */
export class DeterministicGraphBuilder {
    private readonly integrityService = new GraphIntegrityService();

    build(sources: readonly GraphSourceDocument[]): GraphSnapshotV1 {
        const fragment = this.buildFragment(sources);
        const snapshotNodes = sortGraphNodes(fragment.nodes);
        const snapshotEdges = sortGraphEdges(fragment.edges);
        const snapshot: GraphSnapshotV1 = {
            schemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
            nodes: snapshotNodes,
            edges: snapshotEdges,
            stats: {
                documentCount: snapshotNodes.filter((node) => node.type === "document").length,
                sectionCount: snapshotNodes.filter((node) => node.type === "section").length,
                tagCount: snapshotNodes.filter((node) => node.type === "tag").length,
                edgeCount: snapshotEdges.length,
            },
        };
        const report = this.integrityService.check(snapshot);
        if (!report.valid) {
            throw new GraphBuildError(`Graph source produced an invalid deterministic snapshot: ${report.issues.map((issue) => issue.code).join(", ")}.`);
        }

        return snapshot;
    }

    /**
     * Builds only the graph facts emitted by `sources`.
     *
     * `knownDocuments` allows changed files to keep links to unchanged documents
     * without rereading those files. Callers must merge and integrity-check the
     * returned fragment with their existing snapshot before persisting it.
     */
    buildFragment(
        sources: readonly GraphSourceDocument[],
        knownDocuments: readonly DocumentGraphNode[] = [],
    ): GraphBuildFragment {
        const documents = this.normalizeDocuments(sources);
        const documentsByPath = new Map<string, DocumentGraphNode>();
        for (const knownDocument of knownDocuments) {
            documentsByPath.set(normalizeGraphPath(knownDocument.filePath), knownDocument);
        }
        for (const document of documents) {
            documentsByPath.set(document.document.filePath, document.document);
        }
        const nodes: KnowledgeGraphNode[] = [];
        for (const document of documents) {
            nodes.push(document.document, ...document.sections);
        }
        const tagNodesById = new Map<string, TagGraphNode>();
        const edgesById = new Map<string, KnowledgeGraphEdge>();

        for (const document of documents) {
            this.addContainsEdges(document, edgesById);
            this.addReferenceEdges(document, document.links, "links_to", "obsidian-link", edgesById, documentsByPath);
            this.addReferenceEdges(document, document.embeds, "embeds", "obsidian-embed", edgesById, documentsByPath);
            this.addTagEdges(document, tagNodesById, edgesById);
        }

        return {
            nodes: sortGraphNodes([
                ...nodes,
                ...tagNodesById.values(),
            ]),
            edges: sortGraphEdges(Array.from(edgesById.values())),
        };
    }

    private normalizeDocuments(sources: readonly GraphSourceDocument[]): NormalizedGraphSourceDocument[] {
        const documentsById = new Set<string>();
        const documentsByPath = new Set<string>();
        const normalizedDocuments: NormalizedGraphSourceDocument[] = [];

        for (const source of sources) {
            const filePath = normalizeGraphPath(source.filePath);
            const documentId = createDocumentNodeId(source.documentId);
            if (filePath.length === 0 || documentId.length === 0) {
                throw new GraphBuildError("Graph source documents require a non-empty canonical file path and document ID.");
            }
            if (isVaultCoachHiddenPath(filePath)) {
                throw new GraphBuildError(`VaultCoach hidden path cannot enter the graph builder: ${filePath}.`);
            }
            if (documentsById.has(documentId) || documentsByPath.has(filePath)) {
                throw new GraphBuildError(`Graph source documents must have unique document IDs and file paths: ${filePath}.`);
            }
            if (source.title.trim().length === 0) {
                throw new GraphBuildError(`Graph source document requires a title: ${filePath}.`);
            }
            if (source.modifiedAt !== null && !Number.isFinite(source.modifiedAt)) {
                throw new GraphBuildError(`Graph source document has an invalid modified time: ${filePath}.`);
            }

            documentsById.add(documentId);
            documentsByPath.add(filePath);
            const document: DocumentGraphNode = {
                id: documentId,
                type: "document",
                documentId,
                filePath,
                documentType: source.documentType,
                title: source.title.normalize("NFC").trim(),
                contentHash: source.contentHash,
                modifiedAt: source.modifiedAt,
            };
            normalizedDocuments.push({
                document,
                sections: this.normalizeSections(source.sections, document),
                links: source.links.map((reference) => normalizeReference(reference)),
                embeds: source.embeds.map((reference) => normalizeReference(reference)),
                tags: source.tags.map((tag) => normalizeTag(tag)),
            });
        }

        return normalizedDocuments.sort((left, right) => compareStrings(left.document.filePath, right.document.filePath));
    }

    private normalizeSections(
        sourceSections: readonly GraphSourceSection[],
        document: DocumentGraphNode,
    ): SectionGraphNode[] {
        const sectionIds = new Set<string>();
        return sourceSections.map((sourceSection) => {
            const headingPath = normalizeHeadingPath(sourceSection.headingPath);
            if (!Number.isInteger(sourceSection.occurrence) || sourceSection.occurrence < 0) {
                throw new GraphBuildError(`Graph section has an invalid occurrence in ${document.filePath}.`);
            }
            const id = createSectionNodeId(document.documentId, headingPath, sourceSection.occurrence);
            if (sectionIds.has(id)) {
                throw new GraphBuildError(`Graph section occurrence is duplicated in ${document.filePath}: ${headingPath.join(" > ")}.`);
            }
            sectionIds.add(id);
            return {
                id,
                type: "section" as const,
                documentId: document.documentId,
                filePath: document.filePath,
                headingPath,
                occurrence: sourceSection.occurrence,
                chunkIds: normalizeChunkIds(sourceSection.chunkIds),
                locator: normalizeLocator(sourceSection.locator, document.filePath),
            };
        });
    }

    private addContainsEdges(
        document: NormalizedGraphSourceDocument,
        edgesById: Map<string, KnowledgeGraphEdge>,
    ): void {
        const sectionsByHeadingPath = new Map<string, SectionGraphNode[]>();
        for (const section of document.sections) {
            const key = createHeadingPathKey(section.headingPath);
            const sections = sectionsByHeadingPath.get(key) ?? [];
            sections.push(section);
            sectionsByHeadingPath.set(key, sections);
        }

        for (const section of document.sections) {
            const parentHeadingPath = section.headingPath.slice(0, -1);
            const parentSections = section.headingPath.length > 0
                ? sectionsByHeadingPath.get(createHeadingPathKey(parentHeadingPath)) ?? []
                : [];
            // Repeated parent headings cannot be linked without inventing an occurrence relationship.
            const sourceNodeId = parentSections.length === 1
                ? parentSections[0]!.id
                : document.document.id;
            this.addEdge(
                edgesById,
                "contains",
                "heading-structure",
                sourceNodeId,
                section.id,
                CONTAINS_CONFIDENCE,
                createSourceLocation(document.document, "heading-structure", section),
            );
        }
    }

    private addReferenceEdges(
        document: NormalizedGraphSourceDocument,
        references: readonly GraphSourceReference[],
        type: "links_to" | "embeds",
        origin: "obsidian-link" | "obsidian-embed",
        edgesById: Map<string, KnowledgeGraphEdge>,
        documentsByPath: ReadonlyMap<string, DocumentGraphNode>,
    ): void {
        for (const reference of references) {
            const target = documentsByPath.get(reference.targetFilePath);
            if (!target) continue;
            this.addEdge(
                edgesById,
                type,
                origin,
                document.document.id,
                target.id,
                type === "embeds" ? EMBED_CONFIDENCE : LINK_CONFIDENCE,
                createSourceLocation(document.document, origin, reference, target.filePath),
            );
        }
    }

    private addTagEdges(
        document: NormalizedGraphSourceDocument,
        tagNodesById: Map<string, TagGraphNode>,
        edgesById: Map<string, KnowledgeGraphEdge>,
    ): void {
        for (const tag of document.tags) {
            const normalizedName = normalizeGraphTagName(tag.rawName);
            if (normalizedName.length === 0) {
                throw new GraphBuildError(`Graph source tag is empty in ${document.document.filePath}.`);
            }
            const id = createTagNodeId(normalizedName);
            const tagNode: TagGraphNode = {
                id,
                type: "tag",
                normalizedName,
                displayName: normalizedName,
            };
            tagNodesById.set(id, tagNode);
            this.addEdge(
                edgesById,
                "tagged_with",
                "obsidian-tag",
                document.document.id,
                id,
                TAG_CONFIDENCE,
                createSourceLocation(document.document, "obsidian-tag", tag),
            );
        }
    }

    private addEdge(
        edgesById: Map<string, KnowledgeGraphEdge>,
        type: DeterministicKnowledgeEdgeType,
        origin: GraphEdgeOrigin,
        sourceNodeId: string,
        targetNodeId: string,
        confidence: number,
        source: GraphSourceLocation,
    ): void {
        const id = createGraphEdgeId(type, sourceNodeId, targetNodeId);
        const existing = edgesById.get(id);
        if (existing) {
            existing.sources.push(source);
            return;
        }
        edgesById.set(id, {
            id,
            sourceNodeId,
            targetNodeId,
            type,
            confidence,
            origin,
            sources: [source],
        });
    }
}

/** Convenience function for callers that do not need to retain a builder instance. */
export function buildGraphSnapshot(sources: readonly GraphSourceDocument[]): GraphSnapshotV1 {
    return new DeterministicGraphBuilder().build(sources);
}

function normalizeReference(reference: GraphSourceReference): GraphSourceReference {
    return {
        targetFilePath: normalizeGraphPath(reference.targetFilePath),
        chunkIds: normalizeChunkIds(reference.chunkIds),
        ...copyPosition(reference),
    };
}

function normalizeTag(tag: GraphSourceTag): GraphSourceTag {
    return {
        rawName: tag.rawName.normalize("NFC").trim(),
        chunkIds: normalizeChunkIds(tag.chunkIds),
        ...copyPosition(tag),
    };
}

function normalizeLocator(locator: DocumentLocator, documentFilePath: string): DocumentLocator {
    if (locator.type === "markdown") {
        if (normalizeGraphPath(locator.filePath) !== documentFilePath) {
            throw new GraphBuildError(`Markdown section locator does not belong to ${documentFilePath}.`);
        }
        const heading = locator.heading === undefined ? undefined : normalizeHeadingPath([locator.heading])[0];
        return {
            type: "markdown",
            filePath: documentFilePath,
            ...(heading ? { heading } : {}),
        };
    }
    if (locator.type === "pdf") {
        if (normalizeGraphPath(locator.filePath) !== documentFilePath) {
            throw new GraphBuildError(`PDF section locator does not belong to ${documentFilePath}.`);
        }
        return { ...locator, filePath: documentFilePath };
    }
    return { ...locator };
}

function createSourceLocation(
    document: DocumentGraphNode,
    sourceKind: GraphEdgeOrigin,
    position: SourcePosition,
    targetFilePath?: string,
): GraphSourceLocation {
    return {
        sourceFilePath: document.filePath,
        sourceDocumentId: document.documentId,
        sourceKind,
        ...(targetFilePath ? { targetFilePath } : {}),
        chunkIds: normalizeChunkIds(position.chunkIds),
        ...copyPosition(position),
    };
}

function copyPosition(value: Pick<SourcePosition, "startLine" | "startColumn" | "endLine" | "endColumn">): Pick<
    GraphSourceLocation,
    "startLine" | "startColumn" | "endLine" | "endColumn"
> {
    return {
        ...(value.startLine === undefined ? {} : { startLine: value.startLine }),
        ...(value.startColumn === undefined ? {} : { startColumn: value.startColumn }),
        ...(value.endLine === undefined ? {} : { endLine: value.endLine }),
        ...(value.endColumn === undefined ? {} : { endColumn: value.endColumn }),
    };
}

function normalizeChunkIds(chunkIds: readonly string[]): string[] {
    return Array.from(new Set(chunkIds.map((chunkId) => chunkId.normalize("NFC").trim())))
        .filter((chunkId) => chunkId.length > 0)
        .sort(compareStrings);
}

function createHeadingPathKey(headingPath: readonly string[]): string {
    return normalizeHeadingPath(headingPath).join("\u0000");
}

function compareStrings(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}
