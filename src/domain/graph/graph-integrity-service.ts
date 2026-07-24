import {
    createDocumentNodeId,
    createGraphEdgeId,
    createSectionNodeId,
    createTagNodeId,
    isGraphEdgesSorted,
    isGraphNodesSorted,
    isGraphSourceLocationsSorted,
    isVaultCoachHiddenPath,
    normalizeGraphPath,
    normalizeGraphTagName,
    normalizeHeadingPath,
} from "./graph-id";
import { GRAPH_SNAPSHOT_SCHEMA_VERSION } from "./graph-types";
import type {
    DocumentGraphNode,
    GraphIntegrityIssue,
    GraphIntegrityReport,
    GraphSourceLocation,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    GraphSnapshotV1,
    SectionGraphNode,
} from "./graph-types";

/** Validates every invariant required before a deterministic graph snapshot is persisted. */
export class GraphIntegrityService {
    check(snapshot: GraphSnapshotV1): GraphIntegrityReport {
        const issues: GraphIntegrityIssue[] = [];
        if (snapshot.schemaVersion !== GRAPH_SNAPSHOT_SCHEMA_VERSION) {
            issues.push({
                code: "unsupported-schema",
                message: `Unsupported graph snapshot schema: ${String(snapshot.schemaVersion)}.`,
            });
        }

        const nodesById = new Map<string, KnowledgeGraphNode>();
        const documentNodesById = new Map<string, DocumentGraphNode>();
        for (const node of snapshot.nodes) {
            if (nodesById.has(node.id)) {
                issues.push({
                    code: "duplicate-node-id",
                    message: `Duplicate graph node ID: ${node.id}.`,
                    nodeId: node.id,
                });
                continue;
            }

            nodesById.set(node.id, node);
            if (node.type === "document") documentNodesById.set(node.id, node);
            this.checkNode(node, issues);
        }

        for (const node of snapshot.nodes) {
            if (node.type === "section") this.checkSectionOwner(node, documentNodesById, issues);
        }

        const edgesById = new Set<string>();
        for (const edge of snapshot.edges) {
            if (edgesById.has(edge.id)) {
                issues.push({
                    code: "duplicate-edge-id",
                    message: `Duplicate graph edge ID: ${edge.id}.`,
                    edgeId: edge.id,
                });
                continue;
            }
            edgesById.add(edge.id);
            this.checkEdge(edge, nodesById, documentNodesById, issues);
        }

        if (!isGraphNodesSorted(snapshot.nodes)) {
            issues.push({ code: "unsorted-snapshot", message: "Graph nodes are not sorted by canonical ID." });
        }
        if (!isGraphEdgesSorted(snapshot.edges)) {
            issues.push({ code: "unsorted-snapshot", message: "Graph edges are not sorted by canonical ID." });
        }
        for (const edge of snapshot.edges) {
            if (!isGraphSourceLocationsSorted(edge.sources)) {
                issues.push({
                    code: "unsorted-snapshot",
                    message: `Graph edge sources are not canonically sorted: ${edge.id}.`,
                    edgeId: edge.id,
                });
            }
        }
        this.checkStats(snapshot, issues);

        return { valid: issues.length === 0, issues };
    }

    private checkNode(
        node: KnowledgeGraphNode,
        issues: GraphIntegrityIssue[],
    ): void {
        if (node.type === "document") {
            if (node.id !== createDocumentNodeId(node.documentId) || node.filePath !== normalizeGraphPath(node.filePath)) {
                issues.push({
                    code: "non-canonical-id",
                    message: `Document node is not canonically identified: ${node.id}.`,
                    nodeId: node.id,
                });
            }
            if (isVaultCoachHiddenPath(node.filePath)) {
                issues.push({
                    code: "hidden-path-leak",
                    message: `Hidden VaultCoach path entered the graph: ${node.filePath}.`,
                    nodeId: node.id,
                });
            }
            return;
        }

        if (node.type === "section") {
            if (
                node.id !== createSectionNodeId(node.documentId, node.headingPath, node.occurrence)
                || node.filePath !== normalizeGraphPath(node.filePath)
                || node.headingPath.some((heading, index) => heading !== normalizeHeadingPath(node.headingPath)[index])
            ) {
                issues.push({
                    code: "non-canonical-id",
                    message: `Section node is not canonically identified: ${node.id}.`,
                    nodeId: node.id,
                });
            }
            if (isVaultCoachHiddenPath(node.filePath)) {
                issues.push({
                    code: "hidden-path-leak",
                    message: `Hidden VaultCoach path entered the graph: ${node.filePath}.`,
                    nodeId: node.id,
                });
            }
            return;
        }

        if (node.id !== createTagNodeId(node.normalizedName) || node.normalizedName !== normalizeGraphTagName(node.normalizedName)) {
            issues.push({
                code: "non-canonical-id",
                message: `Tag node is not canonically identified: ${node.id}.`,
                nodeId: node.id,
            });
        }
    }

    private checkSectionOwner(
        section: SectionGraphNode,
        documentNodesById: ReadonlyMap<string, DocumentGraphNode>,
        issues: GraphIntegrityIssue[],
    ): void {
        const owner: DocumentGraphNode | undefined = documentNodesById.get(section.documentId);
        if (!owner || owner.filePath !== section.filePath) {
            issues.push({
                code: "invalid-section-owner",
                message: `Section ${section.id} does not belong to an existing document node.`,
                nodeId: section.id,
            });
        }
    }

    private checkEdge(
        edge: KnowledgeGraphEdge,
        nodesById: ReadonlyMap<string, KnowledgeGraphNode>,
        documentNodesById: ReadonlyMap<string, DocumentGraphNode>,
        issues: GraphIntegrityIssue[],
    ): void {
        const sourceNode: KnowledgeGraphNode | undefined = nodesById.get(edge.sourceNodeId);
        const targetNode: KnowledgeGraphNode | undefined = nodesById.get(edge.targetNodeId);
        if (!sourceNode || !targetNode) {
            issues.push({
                code: "missing-edge-endpoint",
                message: `Graph edge ${edge.id} has a missing endpoint.`,
                edgeId: edge.id,
            });
            return;
        }

        if (edge.id !== createGraphEdgeId(edge.type, edge.sourceNodeId, edge.targetNodeId)) {
            issues.push({
                code: "non-canonical-id",
                message: `Graph edge is not canonically identified: ${edge.id}.`,
                edgeId: edge.id,
            });
        }
        if (!this.hasValidEdgeShape(edge, sourceNode, targetNode)) {
            issues.push({
                code: "invalid-edge-shape",
                message: `Graph edge has an invalid type or endpoint combination: ${edge.id}.`,
                edgeId: edge.id,
            });
        }
        if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) {
            issues.push({
                code: "invalid-edge-shape",
                message: `Graph edge confidence must be between 0 and 1: ${edge.id}.`,
                edgeId: edge.id,
            });
        }
        if (edge.sources.length === 0) {
            issues.push({
                code: "invalid-source",
                message: `Graph edge has no source evidence: ${edge.id}.`,
                edgeId: edge.id,
            });
        }

        for (const source of edge.sources) {
            this.checkEdgeSource(edge, source, targetNode, documentNodesById, issues);
        }
    }

    private hasValidEdgeShape(
        edge: KnowledgeGraphEdge,
        sourceNode: KnowledgeGraphNode,
        targetNode: KnowledgeGraphNode,
    ): boolean {
        if (edge.type === "contains") {
            return edge.origin === "heading-structure"
                && targetNode.type === "section"
                && (
                    (sourceNode.type === "document" && sourceNode.documentId === targetNode.documentId)
                    || (sourceNode.type === "section" && sourceNode.documentId === targetNode.documentId)
                );
        }
        if (edge.type === "links_to") {
            return edge.origin === "obsidian-link" && sourceNode.type === "document" && targetNode.type === "document";
        }
        if (edge.type === "embeds") {
            return edge.origin === "obsidian-embed" && sourceNode.type === "document" && targetNode.type === "document";
        }
        return edge.origin === "obsidian-tag" && sourceNode.type === "document" && targetNode.type === "tag";
    }

    private checkEdgeSource(
        edge: KnowledgeGraphEdge,
        source: GraphSourceLocation,
        targetNode: KnowledgeGraphNode,
        documentNodesById: ReadonlyMap<string, DocumentGraphNode>,
        issues: GraphIntegrityIssue[],
    ): void {
        const sourceDocument: DocumentGraphNode | undefined = documentNodesById.get(source.sourceDocumentId);
        const hasValidLocation = source.sourceFilePath === normalizeGraphPath(source.sourceFilePath)
            && source.sourceDocumentId === createDocumentNodeId(source.sourceDocumentId)
            && source.sourceKind === edge.origin
            && this.hasValidOptionalPosition(source);
        if (!sourceDocument || sourceDocument.filePath !== source.sourceFilePath || !hasValidLocation) {
            issues.push({
                code: "invalid-source",
                message: `Graph edge has an invalid source evidence record: ${edge.id}.`,
                edgeId: edge.id,
            });
        }
        if (isVaultCoachHiddenPath(source.sourceFilePath) || (source.targetFilePath && isVaultCoachHiddenPath(source.targetFilePath))) {
            issues.push({
                code: "hidden-path-leak",
                message: `Hidden VaultCoach path entered graph edge evidence: ${edge.id}.`,
                edgeId: edge.id,
            });
        }
        if (
            (edge.type === "links_to" || edge.type === "embeds")
            && targetNode.type === "document"
            && source.targetFilePath !== targetNode.filePath
        ) {
            issues.push({
                code: "invalid-source",
                message: `Graph edge target evidence does not match its document endpoint: ${edge.id}.`,
                edgeId: edge.id,
            });
        }
    }

    private hasValidOptionalPosition(source: GraphSourceLocation): boolean {
        return [source.startLine, source.startColumn, source.endLine, source.endColumn]
            .every((value: number | undefined) => value === undefined || (Number.isInteger(value) && value >= 0));
    }

    private checkStats(snapshot: GraphSnapshotV1, issues: GraphIntegrityIssue[]): void {
        const expected = {
            documentCount: snapshot.nodes.filter((node) => node.type === "document").length,
            sectionCount: snapshot.nodes.filter((node) => node.type === "section").length,
            tagCount: snapshot.nodes.filter((node) => node.type === "tag").length,
            edgeCount: snapshot.edges.length,
        };
        if (
            snapshot.stats.documentCount !== expected.documentCount
            || snapshot.stats.sectionCount !== expected.sectionCount
            || snapshot.stats.tagCount !== expected.tagCount
            || snapshot.stats.edgeCount !== expected.edgeCount
        ) {
            issues.push({
                code: "invalid-snapshot-stats",
                message: "Graph snapshot statistics do not match its nodes and edges.",
            });
        }
    }
}
