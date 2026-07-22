import type { DocumentLocator } from "../documents/document-types";
import type { DeterministicKnowledgeEdgeType, GraphSourceLocation } from "../graph/graph-types";
import type { SemanticRelationType } from "../semantic-graph/semantic-graph-types";

export const LEARNING_GRAPH_MAX_NODES = 150;
export const LEARNING_GRAPH_MAX_EDGES = 300;

export type LearningGraphNodeKind = "concept" | "document" | "section" | "tag";
export type LearningGraphRelationType = SemanticRelationType | DeterministicKnowledgeEdgeType;
export type LearningGraphEdgeOrigin = "semantic" | "structural" | "user";

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
    confidence: number;
    evidence: LearningGraphEvidence[];
}

export interface LearningGraphQuery {
    focusNodeId?: string;
    search?: string;
    filePath?: string;
    folderPath?: string;
    relationTypes?: SemanticRelationType[];
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

/** A bounded, renderer-ready read model reconstructed from M2 + M3 facts. */
export interface LearningGraphProjection {
    nodes: LearningGraphNode[];
    edges: LearningGraphEdge[];
    query: LearningGraphQuery;
    stats: LearningGraphProjectionStats;
    sourceReady: boolean;
    message: string | null;
}

/**
 * Unbounded semantic catalog for domain computation only. Unlike a renderer
 * projection, it contains no layout data, structural nodes, or candidates.
 */
export interface LearningGraphConceptCatalogEntry {
    id: string;
    label: string;
    aliases: string[];
    sourcePaths: string[];
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
