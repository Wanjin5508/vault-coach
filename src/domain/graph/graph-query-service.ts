import { normalizeGraphPath } from "./graph-id";
import type {
    GraphSnapshotV1,
    GraphSourceLocation,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
} from "./graph-types";

/**
 * Pure, read-only access to deterministic graph facts.
 *
 * Every returned value is cloned so a future presentation consumer cannot
 * mutate the persisted snapshot retained by the application service.
 */
export class GraphQueryService {
    getNode(snapshot: GraphSnapshotV1, nodeId: string): KnowledgeGraphNode | null {
        const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
        return node ? cloneKnowledgeGraphNode(node) : null;
    }

    findNodesByDocumentPath(snapshot: GraphSnapshotV1, filePath: string): KnowledgeGraphNode[] {
        const normalizedPath = normalizeGraphPath(filePath);
        return snapshot.nodes
            .filter((node) => node.type !== "tag" && node.filePath === normalizedPath)
            .map(cloneKnowledgeGraphNode);
    }

    findEdgesForNode(snapshot: GraphSnapshotV1, nodeId: string): KnowledgeGraphEdge[] {
        return snapshot.edges
            .filter((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
            .map(cloneKnowledgeGraphEdge);
    }

    findEdgesBySourceFile(snapshot: GraphSnapshotV1, filePath: string): KnowledgeGraphEdge[] {
        const normalizedPath = normalizeGraphPath(filePath);
        return snapshot.edges
            .filter((edge) => edge.sources.some((source) => source.sourceFilePath === normalizedPath))
            .map(cloneKnowledgeGraphEdge);
    }

    getEdgeSources(snapshot: GraphSnapshotV1, edgeId: string): GraphSourceLocation[] {
        const edge = snapshot.edges.find((candidate) => candidate.id === edgeId);
        return edge ? edge.sources.map(cloneGraphSourceLocation) : [];
    }
}

export function cloneGraphSnapshot(snapshot: GraphSnapshotV1): GraphSnapshotV1 {
    return {
        schemaVersion: snapshot.schemaVersion,
        nodes: snapshot.nodes.map(cloneKnowledgeGraphNode),
        edges: snapshot.edges.map(cloneKnowledgeGraphEdge),
        stats: { ...snapshot.stats },
    };
}

export function cloneKnowledgeGraphNode(node: KnowledgeGraphNode): KnowledgeGraphNode {
    if (node.type === "document" || node.type === "tag") return { ...node };
    return {
        ...node,
        headingPath: [...node.headingPath],
        chunkIds: [...node.chunkIds],
        locator: { ...node.locator },
    };
}

export function cloneKnowledgeGraphEdge(edge: KnowledgeGraphEdge): KnowledgeGraphEdge {
    return {
        ...edge,
        sources: edge.sources.map(cloneGraphSourceLocation),
    };
}

export function cloneGraphSourceLocation(source: GraphSourceLocation): GraphSourceLocation {
    return {
        ...source,
        chunkIds: [...source.chunkIds],
    };
}
