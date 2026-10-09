import { normalizeGraphPath } from "./graph-id";
import type {
    GraphSnapshotV1,
    GraphSourceLocation,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
} from "./graph-types";

/**
 * 确定性图事实的纯只读访问服务。
 *
 * 所有返回值都经过克隆，防止展示层消费者修改应用服务持有的持久化快照。
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

/** 深拷贝快照中的可变数组和定位对象，隔离领域缓存与调用方。 */
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
