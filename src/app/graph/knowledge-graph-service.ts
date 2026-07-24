import {
    createDocumentNodeId,
    createGraphEdgeId,
    normalizeGraphPath,
    sortGraphEdges,
    sortGraphNodes,
} from "../../domain/graph/graph-id";
import { GraphIntegrityService } from "../../domain/graph/graph-integrity-service";
import {
    cloneGraphSnapshot,
    cloneGraphSourceLocation,
    cloneKnowledgeGraphEdge,
    cloneKnowledgeGraphNode,
    GraphQueryService,
} from "../../domain/graph/graph-query-service";
import type { GraphStore } from "../../domain/graph/graph-store";
import type { KnowledgeBaseSyncResult } from "../../domain/documents/document-types";
import type {
    GraphIntegrityReport,
    GraphSnapshotV1,
    GraphRename,
    GraphSourceDocument,
    GraphSourceLocation,
    DocumentGraphNode,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
} from "../../domain/graph/graph-types";

export interface GraphSourceDiagnostic {
    code: string;
    filePath: string;
    message: string;
    link?: string;
}

/** Application port implemented by the Obsidian metadata adapter. */
export interface GraphSourceReader {
    readAll(): {
        documents: GraphSourceDocument[];
        diagnostics: GraphSourceDiagnostic[];
    };
    readPaths(filePaths: readonly string[]): {
        documents: GraphSourceDocument[];
        diagnostics: GraphSourceDiagnostic[];
    };
}

/** Application port implemented by the pure deterministic graph builder. */
export interface GraphSnapshotBuilder {
    build(sources: readonly GraphSourceDocument[]): GraphSnapshotV1;
    buildFragment(
        sources: readonly GraphSourceDocument[],
        knownDocuments: readonly DocumentGraphNode[],
    ): {
        nodes: KnowledgeGraphNode[];
        edges: KnowledgeGraphEdge[];
    };
}

export interface KnowledgeGraphState {
    dirty: boolean;
    hasSnapshot: boolean;
    lastError: string | null;
    diagnostics: GraphSourceDiagnostic[];
    integrity: GraphIntegrityReport;
}

/**
 * Coordinates graph source reads, pure construction, validation, and local persistence.
 *
 * It intentionally owns no Obsidian objects. A graph failure leaves the text index and
 * the previous valid graph snapshot intact, while exposing a dirty state for retry.
 */
export class KnowledgeGraphService {
    private readonly integrityService = new GraphIntegrityService();
    private readonly queryService = new GraphQueryService();
    private snapshot: GraphSnapshotV1 | null = null;
    private dirty = false;
    private lastError: string | null = null;
    private diagnostics: GraphSourceDiagnostic[] = [];
    private latestIntegrityReport: GraphIntegrityReport = { valid: true, issues: [] };

    constructor(
        private readonly sourceReader: GraphSourceReader,
        private readonly builder: GraphSnapshotBuilder,
        private readonly store: GraphStore,
    ) {}

    async load(): Promise<void> {
        try {
            const snapshot = await this.store.load();
            const report = snapshot ? this.integrityService.check(snapshot) : { valid: true, issues: [] };
            this.latestIntegrityReport = cloneIntegrityReport(report);
            if (!report.valid) {
                throw new Error(`图谱完整性校验失败：${report.issues.map((issue) => issue.code).join(", ")}`);
            }
            this.snapshot = snapshot ? cloneGraphSnapshot(snapshot) : null;
            this.dirty = false;
            this.lastError = null;
            this.diagnostics = [];
        } catch (error: unknown) {
            this.dirty = true;
            this.lastError = describeError(error);
            this.diagnostics = [];
        }
    }

    async rebuildAll(signal?: AbortSignal): Promise<GraphSnapshotV1> {
        try {
            signal?.throwIfAborted();
            const sourceResult = this.sourceReader.readAll();
            signal?.throwIfAborted();
            const snapshot = this.builder.build(sourceResult.documents);
            this.assertIntegrity(snapshot);
            signal?.throwIfAborted();
            await this.store.save(snapshot);
            signal?.throwIfAborted();

            this.snapshot = cloneGraphSnapshot(snapshot);
            this.diagnostics = cloneDiagnostics(sourceResult.diagnostics);
            this.dirty = this.diagnostics.length > 0;
            this.lastError = null;
            return cloneGraphSnapshot(snapshot);
        } catch (error: unknown) {
            this.dirty = true;
            this.lastError = describeError(error);
            throw error;
        }
    }

    /**
     * Replaces only facts contributed by changed files. A missing requested
     * source means that file was deleted or moved out of the knowledge scope.
     *
     * A paired rename preserves links from unchanged documents by migrating
     * their target endpoint and evidence path to the new document identity.
     */
    async syncChangedFiles(
        syncResult: Pick<KnowledgeBaseSyncResult, "affectedFiles">,
        renames: readonly GraphRename[] = [],
        signal?: AbortSignal,
    ): Promise<GraphSnapshotV1> {
        if (!this.snapshot) return this.rebuildAll(signal);

        const normalizedAffectedPaths = normalizePaths(syncResult.affectedFiles);
        const normalizedRenames = normalizeRenames(renames);
        if (normalizedAffectedPaths.length === 0 && normalizedRenames.length === 0) {
            return cloneGraphSnapshot(this.snapshot);
        }

        try {
            signal?.throwIfAborted();
            const pathsToRead = normalizePaths([
                ...normalizedAffectedPaths,
                ...normalizedRenames.map((rename) => rename.newPath),
            ]);
            const sourceResult = this.sourceReader.readPaths(pathsToRead);
            signal?.throwIfAborted();

            const previousSnapshot = this.snapshot;
            const replacementPaths = new Set<string>([
                ...normalizedAffectedPaths,
                ...normalizedRenames.flatMap((rename) => [rename.oldPath, rename.newPath]),
            ]);
            const currentSourcesByPath = new Map<string, GraphSourceDocument>(
                sourceResult.documents.map((document) => [normalizeGraphPath(document.filePath), document]),
            );
            const previousDocumentsByPath = new Map<string, DocumentGraphNode>(
                previousSnapshot.nodes
                    .filter((node): node is DocumentGraphNode => node.type === "document")
                    .map((node) => [node.filePath, node]),
            );
            const migrations = createRenameMigrations(
                normalizedRenames,
                previousDocumentsByPath,
                currentSourcesByPath,
            );
            const migrationByOldDocumentId = new Map(migrations.map((migration) => [migration.oldDocumentId, migration]));
            const pathsWithCurrentDocuments = new Set(currentSourcesByPath.keys());
            const removedDocumentIds = new Set(
                Array.from(previousDocumentsByPath.values())
                    .filter((document) => replacementPaths.has(document.filePath))
                    .filter((document) => !pathsWithCurrentDocuments.has(document.filePath))
                    .filter((document) => !migrationByOldDocumentId.has(document.id))
                    .map((document) => document.id),
            );

            const retainedNodes = previousSnapshot.nodes.filter((node) => {
                return node.type === "tag" || !replacementPaths.has(node.filePath);
            });
            const knownDocuments = retainedNodes.filter((node): node is DocumentGraphNode => node.type === "document");
            const fragment = this.builder.buildFragment(sourceResult.documents, knownDocuments);
            const mergedNodes = mergeNodes(retainedNodes, fragment.nodes);
            const migratedEdges = previousSnapshot.edges
                .filter((edge) => !edge.sources.some((source) => replacementPaths.has(source.sourceFilePath)))
                .map((edge) => migrateEdgeTarget(edge, migrationByOldDocumentId))
                .filter((edge): edge is KnowledgeGraphEdge => edge !== null)
                .filter((edge) => !removedDocumentIds.has(edge.targetNodeId));
            const mergedEdges = mergeEdges(migratedEdges, fragment.edges);
            const snapshot = createSnapshot(
                pruneOrphanedTagNodes(mergedNodes, mergedEdges),
                mergedEdges,
            );
            this.assertIntegrity(snapshot);

            signal?.throwIfAborted();
            await this.store.save(snapshot);
            signal?.throwIfAborted();
            this.snapshot = cloneGraphSnapshot(snapshot);
            this.diagnostics = cloneDiagnostics(sourceResult.diagnostics);
            this.dirty = this.diagnostics.length > 0;
            this.lastError = null;
            return cloneGraphSnapshot(snapshot);
        } catch (error: unknown) {
            this.dirty = true;
            this.lastError = describeError(error);
            throw error;
        }
    }

    async clear(): Promise<void> {
        await this.store.clear();
        this.snapshot = null;
        this.dirty = false;
        this.lastError = null;
        this.diagnostics = [];
        this.latestIntegrityReport = { valid: true, issues: [] };
    }

    markDirty(): void {
        this.dirty = true;
    }

    getState(): KnowledgeGraphState {
        return {
            dirty: this.dirty,
            hasSnapshot: this.snapshot !== null,
            lastError: this.lastError,
            diagnostics: cloneDiagnostics(this.diagnostics),
            integrity: cloneIntegrityReport(this.latestIntegrityReport),
        };
    }

    getSnapshot(): GraphSnapshotV1 | null {
        return this.snapshot ? cloneGraphSnapshot(this.snapshot) : null;
    }

    getNode(nodeId: string): KnowledgeGraphNode | null {
        return this.snapshot ? this.queryService.getNode(this.snapshot, nodeId) : null;
    }

    findNodesByDocumentPath(filePath: string): KnowledgeGraphNode[] {
        return this.snapshot ? this.queryService.findNodesByDocumentPath(this.snapshot, filePath) : [];
    }

    findEdgesForNode(nodeId: string): KnowledgeGraphEdge[] {
        return this.snapshot ? this.queryService.findEdgesForNode(this.snapshot, nodeId) : [];
    }

    findEdgesBySourceFile(filePath: string): KnowledgeGraphEdge[] {
        return this.snapshot ? this.queryService.findEdgesBySourceFile(this.snapshot, filePath) : [];
    }

    getEdgeSources(edgeId: string): GraphSourceLocation[] {
        return this.snapshot ? this.queryService.getEdgeSources(this.snapshot, edgeId) : [];
    }

    checkIntegrity(): GraphIntegrityReport {
        return this.snapshot
            ? cloneIntegrityReport(this.integrityService.check(this.snapshot))
            : { valid: true, issues: [] };
    }

    private assertIntegrity(snapshot: GraphSnapshotV1): void {
        const report = this.integrityService.check(snapshot);
        this.latestIntegrityReport = cloneIntegrityReport(report);
        if (!report.valid) {
            throw new Error(`图谱完整性校验失败：${report.issues.map((issue) => issue.code).join(", ")}`);
        }
    }
}

interface RenameMigration {
    oldDocumentId: string;
    oldPath: string;
    newDocumentId: string;
    newPath: string;
}

function normalizePaths(paths: readonly string[]): string[] {
    return Array.from(new Set(paths.map(normalizeGraphPath)))
        .filter((path) => path.length > 0)
        .sort(compareStrings);
}

function normalizeRenames(renames: readonly GraphRename[]): GraphRename[] {
    const deduped = new Map<string, GraphRename>();
    for (const rename of renames) {
        const oldPath = normalizeGraphPath(rename.oldPath);
        const newPath = normalizeGraphPath(rename.newPath);
        if (oldPath.length === 0 || newPath.length === 0 || oldPath === newPath) continue;
        deduped.set(oldPath, { oldPath, newPath });
    }
    return Array.from(deduped.values()).sort((left, right) => compareStrings(left.oldPath, right.oldPath));
}

function createRenameMigrations(
    renames: readonly GraphRename[],
    previousDocumentsByPath: ReadonlyMap<string, DocumentGraphNode>,
    currentSourcesByPath: ReadonlyMap<string, GraphSourceDocument>,
): RenameMigration[] {
    return renames.flatMap((rename) => {
        const previousDocument = previousDocumentsByPath.get(rename.oldPath);
        const currentSource = currentSourcesByPath.get(rename.newPath);
        if (!previousDocument || !currentSource) return [];
        return [{
            oldDocumentId: previousDocument.id,
            oldPath: rename.oldPath,
            newDocumentId: createDocumentNodeId(currentSource.documentId),
            newPath: rename.newPath,
        }];
    });
}

function mergeNodes(
    retainedNodes: readonly KnowledgeGraphNode[],
    fragmentNodes: readonly KnowledgeGraphNode[],
): KnowledgeGraphNode[] {
    const nodesById = new Map<string, KnowledgeGraphNode>();
    for (const node of retainedNodes) nodesById.set(node.id, cloneKnowledgeGraphNode(node));
    for (const node of fragmentNodes) nodesById.set(node.id, cloneKnowledgeGraphNode(node));
    return sortGraphNodes(Array.from(nodesById.values()));
}

function mergeEdges(
    retainedEdges: readonly KnowledgeGraphEdge[],
    fragmentEdges: readonly KnowledgeGraphEdge[],
): KnowledgeGraphEdge[] {
    const edgesById = new Map<string, KnowledgeGraphEdge>();
    for (const edge of [...retainedEdges, ...fragmentEdges]) {
        const existing = edgesById.get(edge.id);
        if (existing) {
            existing.sources.push(...edge.sources.map(cloneGraphSourceLocation));
            continue;
        }
        edgesById.set(edge.id, cloneKnowledgeGraphEdge(edge));
    }
    return sortGraphEdges(Array.from(edgesById.values()));
}

function migrateEdgeTarget(
    edge: KnowledgeGraphEdge,
    migrations: ReadonlyMap<string, RenameMigration>,
): KnowledgeGraphEdge | null {
    const migration = migrations.get(edge.targetNodeId);
    if (!migration) return cloneKnowledgeGraphEdge(edge);
    if (edge.type !== "links_to" && edge.type !== "embeds") return null;
    return {
        ...cloneKnowledgeGraphEdge(edge),
        id: createGraphEdgeId(edge.type, edge.sourceNodeId, migration.newDocumentId),
        targetNodeId: migration.newDocumentId,
        sources: edge.sources.map((source) => ({
            ...cloneGraphSourceLocation(source),
            ...(source.targetFilePath === migration.oldPath ? { targetFilePath: migration.newPath } : {}),
        })),
    };
}

function pruneOrphanedTagNodes(
    nodes: readonly KnowledgeGraphNode[],
    edges: readonly KnowledgeGraphEdge[],
): KnowledgeGraphNode[] {
    const referencedTagIds = new Set(
        edges
            .filter((edge) => edge.type === "tagged_with")
            .map((edge) => edge.targetNodeId),
    );
    return nodes.filter((node) => node.type !== "tag" || referencedTagIds.has(node.id));
}

function createSnapshot(nodes: readonly KnowledgeGraphNode[], edges: readonly KnowledgeGraphEdge[]): GraphSnapshotV1 {
    const sortedNodes = sortGraphNodes(nodes);
    const sortedEdges = sortGraphEdges(edges);
    return {
        schemaVersion: 1,
        nodes: sortedNodes,
        edges: sortedEdges,
        stats: {
            documentCount: sortedNodes.filter((node) => node.type === "document").length,
            sectionCount: sortedNodes.filter((node) => node.type === "section").length,
            tagCount: sortedNodes.filter((node) => node.type === "tag").length,
            edgeCount: sortedEdges.length,
        },
    };
}

function compareStrings(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function cloneDiagnostics(diagnostics: readonly GraphSourceDiagnostic[]): GraphSourceDiagnostic[] {
    return diagnostics.map((diagnostic) => ({ ...diagnostic }));
}

function cloneIntegrityReport(report: GraphIntegrityReport): GraphIntegrityReport {
    return {
        valid: report.valid,
        issues: report.issues.map((issue) => ({ ...issue })),
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
