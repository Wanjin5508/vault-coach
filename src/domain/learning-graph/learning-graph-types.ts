import type { DocumentLocator } from "../documents/document-types";
import type { DeterministicKnowledgeEdgeType, GraphSourceLocation } from "../graph/graph-types";
import type { SemanticRelationType } from "../semantic-graph/semantic-graph-types";

/** 默认总览保持轻量；用户可主动请求有界完整视图。 */
export const LEARNING_GRAPH_DEFAULT_MAX_NODES = 150;
export const LEARNING_GRAPH_DEFAULT_MAX_EDGES = 300;
/** 本地 Canvas 的硬上限；更大 Vault 由 Knowledge Engine 负责。 */
export const LEARNING_GRAPH_MAX_NODES = 500;
export const LEARNING_GRAPH_MAX_EDGES = 2_000;

export type LearningGraphNodeKind = "concept" | "document" | "section" | "tag";
export type LearningGraphRelationType = SemanticRelationType | DeterministicKnowledgeEdgeType;
export type LearningGraphEdgeOrigin = "semantic" | "structural" | "user";
/** 仅表示视觉来源，不得用于形成学习事实决策。 */
export type LearningGraphEdgeTrust = "confirmed" | "automatic" | "structural";

export interface LearningGraphConceptEvidence {
    kind: "concept-evidence";
    sectionId: string;
    chunkId: string;
    locator: DocumentLocator;
    excerptId: string;
    textPreview: string;
}

export interface LearningGraphStructuralEvidence {
    kind: "structural-evidence";
    source: GraphSourceLocation;
}

export interface LearningGraphUserDecisionEvidence {
    kind: "user-decision";
    decisionId: string;
}

export type LearningGraphEvidence = LearningGraphConceptEvidence | LearningGraphStructuralEvidence | LearningGraphUserDecisionEvidence;

export interface LearningGraphNode {
    id: string;
    kind: LearningGraphNodeKind;
    label: string;
    aliases: string[];
    description: string;
    sourcePaths: string[];
    evidence: LearningGraphEvidence[];
}

export interface LearningGraphEdge {
    id: string;
    type: LearningGraphRelationType;
    sourceNodeId: string;
    targetNodeId: string;
    directed: boolean;
    origin: LearningGraphEdgeOrigin;
    trust: LearningGraphEdgeTrust;
    confidence: number;
    evidence: LearningGraphEvidence[];
}

export interface LearningGraphQuery {
    focusNodeId?: string;
    search?: string;
    filePath?: string;
    folderPath?: string;
    relationTypes?: SemanticRelationType[];
    /** 隐藏仅用于展示的高置信候选，但不修改任何事实。 */
    includeAutomaticRelations?: boolean;
    includeStructuralContext?: boolean;
    depth?: 0 | 1 | 2;
    maxNodes?: number;
    maxEdges?: number;
}

export type LearningGraphTruncationReason = "node-budget" | "edge-budget";

export interface LearningGraphProjectionStats {
    sourceNodeCount: number;
    sourceEdgeCount: number;
    visibleNodeCount: number;
    visibleEdgeCount: number;
    hiddenNodeCount: number;
    hiddenEdgeCount: number;
    truncated: boolean;
    truncationReasons: LearningGraphTruncationReason[];
}

/** 根据 M2 + M3 事实重建的有界、可直接渲染只读模型。 */
export interface LearningGraphProjection {
    nodes: LearningGraphNode[];
    edges: LearningGraphEdge[];
    query: LearningGraphQuery;
    stats: LearningGraphProjectionStats;
    sourceReady: boolean;
    message: string | null;
}

/**
 * 仅供领域计算使用的无渲染预算语义目录。
 * 与渲染投影不同，其中不包含布局数据、结构节点或候选关系。
 */
export interface LearningGraphConceptCatalogEntry {
    id: string;
    label: string;
    aliases: string[];
    sourcePaths: string[];
    /**
     * 用于安全执行 Exam → Concept 和 Assessment → Concept 绑定的精确索引来源。
     *
     * 该信息不属于渲染职责，严禁根据标签、embedding 或图邻域推断。
     */
    sourceChunkIds: string[];
}

export interface LearningGraphConceptCatalog {
    concepts: LearningGraphConceptCatalogEntry[];
    sourceReady: boolean;
    message: string | null;
}

export type LearningGraphIntegrityIssueCode =
    | "duplicate-node-id"
    | "duplicate-edge-id"
    | "missing-edge-endpoint"
    | "invalid-relation-direction"
    | "invalid-evidence"
    | "unsorted-projection";

export interface LearningGraphIntegrityIssue {
    code: LearningGraphIntegrityIssueCode;
    message: string;
    nodeId?: string;
    edgeId?: string;
}

export interface LearningGraphIntegrityReport {
    valid: boolean;
    issues: LearningGraphIntegrityIssue[];
}
