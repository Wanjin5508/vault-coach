import type { DocumentLocator, KnowledgeDocumentType } from "../documents/document-types";

/** Increment only when a persisted graph snapshot becomes incompatible. */
export const GRAPH_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** Node types that can be created without semantic or model inference. */
export type DeterministicKnowledgeNodeType = "document" | "section" | "tag";

/** Edges whose existence can be proven directly from the local Vault structure. */
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

/** A local, inspectable fact explaining why a deterministic edge exists. */
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

/** The persisted, reproducible fact set for the deterministic graph MVP. */
export interface GraphSnapshotV1 {
    schemaVersion: typeof GRAPH_SNAPSHOT_SCHEMA_VERSION;
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
    stats: GraphSnapshotStats;
}

/** Obsidian-free input consumed later by DeterministicGraphBuilder. */
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

/** A paired Vault rename retained until graph edges have been migrated safely. */
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
