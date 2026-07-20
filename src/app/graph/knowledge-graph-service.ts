import { normalizeGraphPath } from "../../domain/graph/graph-id";
import { GraphIntegrityService } from "../../domain/graph/graph-integrity-service";
import type { GraphStore } from "../../domain/graph/graph-store";
import type {
    GraphIntegrityReport,
    GraphSnapshotV1,
    GraphSourceDocument,
    GraphSourceLocation,
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
}

/** Application port implemented by the pure deterministic graph builder. */
export interface GraphSnapshotBuilder {
    build(sources: readonly GraphSourceDocument[]): GraphSnapshotV1;
}

export interface KnowledgeGraphState {
    dirty: boolean;
    hasSnapshot: boolean;
    lastError: string | null;
    diagnostics: GraphSourceDiagnostic[];
}

/**
 * Coordinates graph source reads, pure construction, validation, and local persistence.
 *
 * It intentionally owns no Obsidian objects. A graph failure leaves the text index and
 * the previous valid graph snapshot intact, while exposing a dirty state for retry.
 */
export class KnowledgeGraphService {
    private readonly integrityService = new GraphIntegrityService();
    private snapshot: GraphSnapshotV1 | null = null;
    private dirty = false;
    private lastError: string | null = null;
    private diagnostics: GraphSourceDiagnostic[] = [];

    constructor(
        private readonly sourceReader: GraphSourceReader,
        private readonly builder: GraphSnapshotBuilder,
        private readonly store: GraphStore,
    ) {}

    async load(): Promise<void> {
        try {
            const snapshot = await this.store.load();
            this.snapshot = snapshot ? cloneSnapshot(snapshot) : null;
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
            const report = this.integrityService.check(snapshot);
            if (!report.valid) {
                throw new Error(`图谱完整性校验失败：${report.issues.map((issue) => issue.code).join(", ")}`);
            }
            signal?.throwIfAborted();
            await this.store.save(snapshot);
            signal?.throwIfAborted();

            this.snapshot = cloneSnapshot(snapshot);
            this.diagnostics = cloneDiagnostics(sourceResult.diagnostics);
            this.dirty = this.diagnostics.length > 0;
            this.lastError = null;
            return cloneSnapshot(snapshot);
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
        };
    }

    getSnapshot(): GraphSnapshotV1 | null {
        return this.snapshot ? cloneSnapshot(this.snapshot) : null;
    }

    getNode(nodeId: string): KnowledgeGraphNode | null {
        const node = this.snapshot?.nodes.find((candidate) => candidate.id === nodeId);
        return node ? cloneNode(node) : null;
    }

    findNodesByDocumentPath(filePath: string): KnowledgeGraphNode[] {
        const normalizedPath = normalizeGraphPath(filePath);
        return (this.snapshot?.nodes ?? [])
            .filter((node) => node.type !== "tag" && node.filePath === normalizedPath)
            .map(cloneNode);
    }

    findEdgesForNode(nodeId: string): KnowledgeGraphEdge[] {
        return (this.snapshot?.edges ?? [])
            .filter((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
            .map(cloneEdge);
    }

    findEdgesBySourceFile(filePath: string): KnowledgeGraphEdge[] {
        const normalizedPath = normalizeGraphPath(filePath);
        return (this.snapshot?.edges ?? [])
            .filter((edge) => edge.sources.some((source) => source.sourceFilePath === normalizedPath))
            .map(cloneEdge);
    }

    getEdgeSources(edgeId: string): GraphSourceLocation[] {
        const edge = this.snapshot?.edges.find((candidate) => candidate.id === edgeId);
        return edge ? edge.sources.map(cloneSourceLocation) : [];
    }

    checkIntegrity(): GraphIntegrityReport {
        return this.snapshot
            ? cloneIntegrityReport(this.integrityService.check(this.snapshot))
            : { valid: true, issues: [] };
    }
}

function cloneSnapshot(snapshot: GraphSnapshotV1): GraphSnapshotV1 {
    return {
        schemaVersion: snapshot.schemaVersion,
        nodes: snapshot.nodes.map(cloneNode),
        edges: snapshot.edges.map(cloneEdge),
        stats: { ...snapshot.stats },
    };
}

function cloneNode(node: KnowledgeGraphNode): KnowledgeGraphNode {
    if (node.type === "document" || node.type === "tag") return { ...node };
    return {
        ...node,
        headingPath: [...node.headingPath],
        chunkIds: [...node.chunkIds],
        locator: { ...node.locator },
    };
}

function cloneEdge(edge: KnowledgeGraphEdge): KnowledgeGraphEdge {
    return {
        ...edge,
        sources: edge.sources.map(cloneSourceLocation),
    };
}

function cloneSourceLocation(source: GraphSourceLocation): GraphSourceLocation {
    return {
        ...source,
        chunkIds: [...source.chunkIds],
    };
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
