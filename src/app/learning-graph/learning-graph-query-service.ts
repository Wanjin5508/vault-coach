import { LEARNING_GRAPH_DEFAULT_MAX_EDGES, LEARNING_GRAPH_DEFAULT_MAX_NODES, LEARNING_GRAPH_MAX_EDGES, LEARNING_GRAPH_MAX_NODES, type LearningGraphConceptCatalog, type LearningGraphEdge, type LearningGraphNode, type LearningGraphProjection, type LearningGraphQuery } from "../../domain/learning-graph/learning-graph-types";
import { compareLearningGraphEdges, compareLearningGraphNodes } from "../../domain/learning-graph/learning-graph-id";
import { LearningGraphIntegrityService } from "../../domain/learning-graph/learning-graph-integrity";
import type { SemanticRelationType } from "../../domain/semantic-graph/semantic-graph-types";
import type { ConfirmedPrerequisite } from "../../domain/adaptive-exam/adaptive-exam-types";
import { LearningGraphProjectionService } from "./learning-graph-projection-service";
import type { LearningGraphSource } from "./learning-graph-source";

/**
 * The only M4A query service. It builds adjacency once per bounded query and
 * uses BFS for expansion; it never compares every pair of graph nodes.
 */
export class LearningGraphQueryService {
    private readonly projector = new LearningGraphProjectionService();
    private readonly integrity = new LearningGraphIntegrityService();
    private cache = new Map<string, LearningGraphProjection>();

    constructor(private readonly source: LearningGraphSource) {}

    getProjection(query: LearningGraphQuery = {}): LearningGraphProjection {
        const normalizedQuery = normalizeQuery(query);
        const cacheKey = `${this.source.getLearningMapRevision()}\u0000${JSON.stringify(normalizedQuery)}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cloneProjection(cached);
        const snapshot = this.source.getStructuralSnapshot();
        if (!snapshot) return createUnavailableProjection(normalizedQuery);
        const semantic = this.source.getEffectiveSemanticGraph();
        const facts = this.projector.build(
            snapshot,
            semantic,
            this.source.getAutoDisplayRelations(),
            normalizedQuery.includeStructuralContext === true,
        );
        const projection = projectFacts(facts.nodes, facts.edges, normalizedQuery);
        const report = this.integrity.check(projection);
        if (!report.valid) throw new Error(`Learning graph integrity check failed: ${report.issues.map((issue) => issue.code).join(", ")}`);
        this.cache.set(cacheKey, cloneProjection(projection));
        return projection;
    }

    /**
     * Domain-facing catalog for Mastery. It deliberately bypasses renderer
     * budgets but still exposes only M3 effective Concepts.
     */
    getConceptCatalog(): LearningGraphConceptCatalog {
        const snapshot = this.source.getStructuralSnapshot();
        if (!snapshot) {
            return {
                concepts: [],
                sourceReady: false,
                message: "Rebuild the knowledge index first so the deterministic structural graph is available.",
            };
        }
        const semantic = this.source.getEffectiveSemanticGraph();
        return {
            concepts: semantic.concepts
                .map((concept) => ({
                    id: concept.id,
                    label: concept.displayName,
                    aliases: [...concept.aliases].sort((left, right) => left.localeCompare(right)),
                    sourcePaths: Array.from(new Set(concept.evidence
                        .map((evidence) => evidence.locator.type === "zotero" ? "" : evidence.locator.filePath)
                        .filter((path) => path.length > 0)))
                        .sort((left, right) => left.localeCompare(right)),
                    sourceChunkIds: Array.from(new Set(concept.evidence
                        .map((evidence) => evidence.chunkId)
                        .filter((chunkId) => chunkId.length > 0)))
                        .sort((left, right) => left.localeCompare(right)),
                }))
                .sort((left, right) => left.id.localeCompare(right.id)),
            sourceReady: true,
            message: null,
        };
    }

    /**
     * Builds one bounded, read-only provenance index for an Exam generation.
     * It maps only exact text-index chunk IDs to current effective Concepts;
     * topic labels, graph traversal, embeddings, and candidates are excluded.
     */
    getConceptIdsByChunk(): ReadonlyMap<string, readonly string[]> {
        const catalog = this.getConceptCatalog();
        const conceptIdsByChunk = new Map<string, string[]>();
        if (!catalog.sourceReady) return conceptIdsByChunk;
        for (const concept of catalog.concepts) {
            for (const chunkId of concept.sourceChunkIds) {
                const conceptIds = conceptIdsByChunk.get(chunkId) ?? [];
                if (!conceptIds.includes(concept.id)) conceptIds.push(concept.id);
                conceptIdsByChunk.set(chunkId, conceptIds);
            }
        }
        for (const conceptIds of conceptIdsByChunk.values()) {
            conceptIds.sort((left, right) => left.localeCompare(right));
        }
        return conceptIdsByChunk;
    }

    /**
     * Returns only effective, directed prerequisite relations.  This is a
     * domain read model for adaptive exams: it never includes pending
     * candidates, display-only automatic relations, or inferred edges.
     */
    getConfirmedPrerequisites(): readonly ConfirmedPrerequisite[] {
        const snapshot = this.source.getStructuralSnapshot();
        if (!snapshot) return [];
        return this.source.getEffectiveSemanticGraph().relations
            .filter((relation) => relation.type === "prerequisite_of")
            .map((relation) => ({
                prerequisiteConceptId: relation.sourceConceptId,
                targetConceptId: relation.targetConceptId,
                relationId: relation.id,
            }))
            .sort((left, right) => left.relationId.localeCompare(right.relationId));
    }

    /** A stable source revision used to reject stale adaptive exam plans. */
    getRevision(): string {
        return this.source.getLearningMapRevision();
    }

    invalidate(): void {
        this.cache.clear();
    }
}

function projectFacts(nodes: readonly LearningGraphNode[], edges: readonly LearningGraphEdge[], query: LearningGraphQuery): LearningGraphProjection {
    const filteredEdges = edges.filter((edge) => (
        (query.includeAutomaticRelations !== false || edge.trust !== "automatic")
        && (query.relationTypes === undefined
            || edge.origin === "structural"
            || query.relationTypes.includes(edge.type as SemanticRelationType))
    ));
    const visibleSourceNodeIds = selectSourceNodeIds(nodes, filteredEdges, query);
    const sourceNodes = nodes.filter((node) => visibleSourceNodeIds.has(node.id));
    const sourceEdges = filteredEdges.filter((edge) => visibleSourceNodeIds.has(edge.sourceNodeId) && visibleSourceNodeIds.has(edge.targetNodeId));
    const degreeById = createDegreeMap(sourceEdges);
    const rankedNodes = [...sourceNodes].sort((left, right) => compareNodePriority(left, right, query, degreeById));
    const selectedNodeIds = new Set(rankedNodes.slice(0, query.maxNodes).map((node) => node.id));
    const rankedEdges = sourceEdges
        .filter((edge) => selectedNodeIds.has(edge.sourceNodeId) && selectedNodeIds.has(edge.targetNodeId))
        .sort((left, right) => compareEdgePriority(left, right, query));
    const selectedEdges = rankedEdges.slice(0, query.maxEdges);
    const projection: LearningGraphProjection = {
        nodes: nodes
            .filter((node) => selectedNodeIds.has(node.id))
            .sort(compareLearningGraphNodes)
            .map(cloneNode),
        edges: selectedEdges.sort(compareLearningGraphEdges).map(cloneEdge),
        query: { ...query, relationTypes: query.relationTypes ? [...query.relationTypes] : undefined },
        stats: {
            sourceNodeCount: sourceNodes.length,
            sourceEdgeCount: sourceEdges.length,
            visibleNodeCount: selectedNodeIds.size,
            visibleEdgeCount: selectedEdges.length,
            hiddenNodeCount: Math.max(0, sourceNodes.length - selectedNodeIds.size),
            hiddenEdgeCount: Math.max(0, sourceEdges.length - selectedEdges.length),
            truncated: sourceNodes.length > selectedNodeIds.size || sourceEdges.length > selectedEdges.length,
            truncationReasons: [
                ...(sourceNodes.length > selectedNodeIds.size ? ["node-budget" as const] : []),
                ...(sourceEdges.length > selectedEdges.length ? ["edge-budget" as const] : []),
            ],
        },
        sourceReady: true,
        message: sourceNodes.length === 0
            ? "No confirmed concepts match this learning graph query. Pending and rejected candidates are intentionally excluded."
            : null,
    };
    return projection;
}

function selectSourceNodeIds(nodes: readonly LearningGraphNode[], edges: readonly LearningGraphEdge[], query: LearningGraphQuery): Set<string> {
    const nodeIds = new Set(nodes.map((node) => node.id));
    if (query.focusNodeId && nodeIds.has(query.focusNodeId)) {
        const adjacency = createAdjacency(edges);
        const selected = new Set<string>([query.focusNodeId]);
        let frontier = [query.focusNodeId];
        for (let step = 0; step < (query.depth ?? 1); step += 1) {
            const next: string[] = [];
            for (const nodeId of frontier) {
                for (const neighbor of adjacency.get(nodeId) ?? []) {
                    if (selected.has(neighbor)) continue;
                    selected.add(neighbor);
                    next.push(neighbor);
                }
            }
            frontier = next;
            if (frontier.length === 0) break;
        }
        return selected;
    }
    const hasFilter = Boolean(query.search || query.filePath || query.folderPath);
    return new Set(nodes.filter((node) => !hasFilter || matchesNode(node, query)).map((node) => node.id));
}

function matchesNode(node: LearningGraphNode, query: LearningGraphQuery): boolean {
    const search = query.search?.toLocaleLowerCase();
    if (search) {
        const text = [node.label, node.description, ...node.aliases].join("\n").toLocaleLowerCase();
        if (!text.includes(search)) return false;
    }
    if (query.filePath && !node.sourcePaths.includes(query.filePath)) return false;
    if (query.folderPath && !node.sourcePaths.some((path) => path === query.folderPath || path.startsWith(`${query.folderPath}/`))) return false;
    return true;
}

function createAdjacency(edges: readonly LearningGraphEdge[]): Map<string, string[]> {
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
        appendAdjacency(adjacency, edge.sourceNodeId, edge.targetNodeId);
        appendAdjacency(adjacency, edge.targetNodeId, edge.sourceNodeId);
    }
    for (const neighbors of adjacency.values()) neighbors.sort((left, right) => left.localeCompare(right));
    return adjacency;
}

function appendAdjacency(adjacency: Map<string, string[]>, source: string, target: string): void {
    const neighbors = adjacency.get(source) ?? [];
    neighbors.push(target);
    adjacency.set(source, neighbors);
}

function createDegreeMap(edges: readonly LearningGraphEdge[]): Map<string, number> {
    const degrees = new Map<string, number>();
    for (const edge of edges) {
        degrees.set(edge.sourceNodeId, (degrees.get(edge.sourceNodeId) ?? 0) + 1);
        degrees.set(edge.targetNodeId, (degrees.get(edge.targetNodeId) ?? 0) + 1);
    }
    return degrees;
}

function compareNodePriority(left: LearningGraphNode, right: LearningGraphNode, query: LearningGraphQuery, degreeById: ReadonlyMap<string, number>): number {
    const leftFocus = left.id === query.focusNodeId ? 0 : 1;
    const rightFocus = right.id === query.focusNodeId ? 0 : 1;
    return leftFocus - rightFocus
        || (degreeById.get(right.id) ?? 0) - (degreeById.get(left.id) ?? 0)
        || left.label.localeCompare(right.label)
        || compareLearningGraphNodes(left, right);
}

function compareEdgePriority(left: LearningGraphEdge, right: LearningGraphEdge, query: LearningGraphQuery): number {
    const leftFocus = left.sourceNodeId === query.focusNodeId || left.targetNodeId === query.focusNodeId ? 0 : 1;
    const rightFocus = right.sourceNodeId === query.focusNodeId || right.targetNodeId === query.focusNodeId ? 0 : 1;
    return leftFocus - rightFocus || compareLearningGraphEdges(left, right);
}

function normalizeQuery(query: LearningGraphQuery): LearningGraphQuery {
    const relationTypes = query.relationTypes && query.relationTypes.length > 0
        ? Array.from(new Set(query.relationTypes)).sort((left, right) => left.localeCompare(right))
        : undefined;
    return {
        ...(query.focusNodeId?.trim() ? { focusNodeId: query.focusNodeId.trim() } : {}),
        ...(query.search?.trim() ? { search: query.search.trim() } : {}),
        ...(query.filePath?.trim() ? { filePath: normalizePath(query.filePath) } : {}),
        ...(query.folderPath?.trim() ? { folderPath: normalizePath(query.folderPath) } : {}),
        ...(relationTypes ? { relationTypes } : {}),
        ...(query.includeAutomaticRelations === false ? { includeAutomaticRelations: false } : {}),
        ...(query.includeStructuralContext === true ? { includeStructuralContext: true } : {}),
        depth: query.depth ?? 1,
        maxNodes: clampInteger(query.maxNodes, LEARNING_GRAPH_DEFAULT_MAX_NODES, 1, LEARNING_GRAPH_MAX_NODES),
        maxEdges: clampInteger(query.maxEdges, LEARNING_GRAPH_DEFAULT_MAX_EDGES, 1, LEARNING_GRAPH_MAX_EDGES),
    };
}

function createUnavailableProjection(query: LearningGraphQuery): LearningGraphProjection {
    return {
        nodes: [],
        edges: [],
        query,
        stats: { sourceNodeCount: 0, sourceEdgeCount: 0, visibleNodeCount: 0, visibleEdgeCount: 0, hiddenNodeCount: 0, hiddenEdgeCount: 0, truncated: false, truncationReasons: [] },
        sourceReady: false,
        message: "Rebuild the knowledge index first so the deterministic structural graph is available.",
    };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
    const candidate = Number.isFinite(value) ? Math.floor(value!) : fallback;
    return Math.max(min, Math.min(max, candidate));
}

function normalizePath(value: string): string {
    return value.normalize("NFC").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function cloneProjection(projection: LearningGraphProjection): LearningGraphProjection {
    return {
        ...projection,
        nodes: projection.nodes.map(cloneNode),
        edges: projection.edges.map(cloneEdge),
        query: { ...projection.query, relationTypes: projection.query.relationTypes ? [...projection.query.relationTypes] : undefined },
        stats: { ...projection.stats, truncationReasons: [...projection.stats.truncationReasons] },
    };
}

function cloneNode(node: LearningGraphNode): LearningGraphNode {
    return { ...node, aliases: [...node.aliases], sourcePaths: [...node.sourcePaths], evidence: node.evidence.map(cloneEvidence) };
}

function cloneEdge(edge: LearningGraphEdge): LearningGraphEdge {
    return { ...edge, evidence: edge.evidence.map(cloneEvidence) };
}

function cloneEvidence(evidence: LearningGraphNode["evidence"][number]) {
    if (evidence.kind === "concept-evidence") return { ...evidence, locator: { ...evidence.locator } };
    if (evidence.kind === "structural-evidence") return { ...evidence, source: { ...evidence.source, chunkIds: [...evidence.source.chunkIds] } };
    return { ...evidence };
}
