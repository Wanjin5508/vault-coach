import type { DocumentLocator, KnowledgeDocumentType } from "../documents/document-types";

/** 仅当持久化图快照发生不兼容变更时递增。 */
export const GRAPH_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** 无需语义或模型推断即可创建的节点类型。 */
export type DeterministicKnowledgeNodeType = "document" | "section" | "tag";

/** 可由本地 Vault 结构直接证明存在的边类型。 */
export type DeterministicKnowledgeEdgeType =
    | "contains"
    | "links_to"
    | "embeds"
    | "tagged_with";

export interface DocumentGraphNode {
    id: string;
    type: "document";
    documentId: string;
    filePath: string;
    documentType: KnowledgeDocumentType;
    title: string;
    contentHash: string;
    modifiedAt: number | null;
}

export interface SectionGraphNode {
    id: string;
    type: "section";
    documentId: string;
    filePath: string;
    headingPath: string[];
    occurrence: number;
    chunkIds: string[];
    locator: DocumentLocator;
}

export interface TagGraphNode {
    id: string;
    type: "tag";
    normalizedName: string;
    displayName: string;
}

export type KnowledgeGraphNode =
    | DocumentGraphNode
    | SectionGraphNode
    | TagGraphNode;

export type GraphEdgeOrigin =
    | "heading-structure"
    | "obsidian-link"
    | "obsidian-embed"
    | "obsidian-tag";

/** 解释确定性边为何存在的本地可检查事实。 */
export interface GraphSourceLocation {
    sourceFilePath: string;
    sourceDocumentId: string;
    sourceKind: GraphEdgeOrigin;
    targetFilePath?: string;
    chunkIds: string[];
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
}

export interface KnowledgeGraphEdge {
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    type: DeterministicKnowledgeEdgeType;
    confidence: number;
    origin: GraphEdgeOrigin;
    sources: GraphSourceLocation[];
}

export interface GraphSnapshotStats {
    documentCount: number;
    sectionCount: number;
    tagCount: number;
    edgeCount: number;
}

/** 确定性图 MVP 的持久化、可复现事实集合。 */
export interface GraphSnapshotV1 {
    schemaVersion: typeof GRAPH_SNAPSHOT_SCHEMA_VERSION;
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
    stats: GraphSnapshotStats;
}

/** 供 `DeterministicGraphBuilder` 使用且不依赖 Obsidian 的输入。 */
export interface GraphSourceDocument {
    documentId: string;
    filePath: string;
    documentType: KnowledgeDocumentType;
    title: string;
    contentHash: string;
    modifiedAt: number | null;
    sections: GraphSourceSection[];
    links: GraphSourceReference[];
    embeds: GraphSourceReference[];
    tags: GraphSourceTag[];
}

export interface GraphSourceSection {
    headingPath: string[];
    occurrence: number;
    chunkIds: string[];
    locator: DocumentLocator;
}

export interface GraphSourceReference {
    targetFilePath: string;
    chunkIds: string[];
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
}

export interface GraphSourceTag {
    rawName: string;
    chunkIds: string[];
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
}

/** 在图边安全迁移完成前保留的一对 Vault 重命名信息。 */
export interface GraphRename {
    oldPath: string;
    newPath: string;
}

export type GraphIntegrityIssueCode =
    | "unsupported-schema"
    | "duplicate-node-id"
    | "duplicate-edge-id"
    | "missing-edge-endpoint"
    | "invalid-edge-shape"
    | "invalid-source"
    | "invalid-section-owner"
    | "invalid-snapshot-stats"
    | "hidden-path-leak"
    | "non-canonical-id"
    | "unsorted-snapshot";

export interface GraphIntegrityIssue {
    code: GraphIntegrityIssueCode;
    message: string;
    nodeId?: string;
    edgeId?: string;
}

export interface GraphIntegrityReport {
    valid: boolean;
    issues: GraphIntegrityIssue[];
}
