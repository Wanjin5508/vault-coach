import type {
    GraphSourceLocation,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    DeterministicKnowledgeEdgeType,
} from "./graph-types";

const VAULT_COACH_HIDDEN_DIR = ".vault-coach";

/** Produces a stable FNV-1a-style hash without depending on host APIs. */
export function stableGraphHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return `${value.length}:${(hash >>> 0).toString(16)}`;
}

export function normalizeGraphPath(value: string): string {
    const segments: string[] = [];
    for (const segment of value.normalize("NFC").trim().replace(/\\/g, "/").split("/")) {
        const normalizedSegment: string = segment.trim();
        if (normalizedSegment.length === 0 || normalizedSegment === ".") continue;
        if (normalizedSegment === "..") {
            segments.pop();
            continue;
        }
        segments.push(normalizedSegment);
    }

    return segments.join("/");
}

export function normalizeHeadingPath(headingPath: readonly string[]): string[] {
    return headingPath
        .map((heading: string) => normalizeGraphText(heading))
        .filter((heading: string) => heading.length > 0);
}

export function normalizeGraphTagName(value: string): string {
    return normalizeGraphText(value)
        .replace(/^#+\s*/, "")
        .replace(/\s*\/\s*/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
}

export function createDocumentNodeId(documentId: string): string {
    return normalizeGraphText(documentId);
}

export function createSectionNodeId(
    documentId: string,
    headingPath: readonly string[],
    occurrence: number,
): string {
    const normalizedDocumentId: string = createDocumentNodeId(documentId);
    const normalizedOccurrence: number = Number.isInteger(occurrence) && occurrence >= 0 ? occurrence : -1;
    const fingerprint: string = JSON.stringify({
        headingPath: normalizeHeadingPath(headingPath),
        occurrence: normalizedOccurrence,
    });

    return `section:${normalizedDocumentId}:${stableGraphHash(fingerprint)}`;
}

export function createTagNodeId(tagName: string): string {
    return `tag:${normalizeGraphTagName(tagName)}`;
}

export function createGraphEdgeId(
    type: DeterministicKnowledgeEdgeType,
    sourceNodeId: string,
    targetNodeId: string,
): string {
    return `edge:${type}:${normalizeGraphText(sourceNodeId)}:${normalizeGraphText(targetNodeId)}`;
}

export function isVaultCoachHiddenPath(path: string): boolean {
    const normalizedPath: string = normalizeGraphPath(path);
    return normalizedPath === VAULT_COACH_HIDDEN_DIR
        || normalizedPath.startsWith(`${VAULT_COACH_HIDDEN_DIR}/`);
}

export function compareGraphNodeIds(left: Pick<KnowledgeGraphNode, "id">, right: Pick<KnowledgeGraphNode, "id">): number {
    return compareStrings(left.id, right.id);
}

export function compareGraphEdgeIds(left: Pick<KnowledgeGraphEdge, "id">, right: Pick<KnowledgeGraphEdge, "id">): number {
    return compareStrings(left.id, right.id);
}

export function compareGraphSourceLocations(left: GraphSourceLocation, right: GraphSourceLocation): number {
    return compareStrings(createGraphSourceLocationKey(left), createGraphSourceLocationKey(right));
}

export function sortGraphNodes(nodes: readonly KnowledgeGraphNode[]): KnowledgeGraphNode[] {
    return nodes
        .map((node: KnowledgeGraphNode) => cloneGraphNode(node))
        .sort(compareGraphNodeIds);
}

export function sortGraphEdges(edges: readonly KnowledgeGraphEdge[]): KnowledgeGraphEdge[] {
    return edges
        .map((edge: KnowledgeGraphEdge) => ({
            ...edge,
            sources: sortAndDedupeGraphSources(edge.sources),
        }))
        .sort(compareGraphEdgeIds);
}

export function sortAndDedupeGraphSources(sources: readonly GraphSourceLocation[]): GraphSourceLocation[] {
    const sourcesByKey = new Map<string, GraphSourceLocation>();
    for (const source of sources) {
        const normalizedSource: GraphSourceLocation = normalizeGraphSourceLocation(source);
        sourcesByKey.set(createGraphSourceLocationKey(normalizedSource), normalizedSource);
    }

    return Array.from(sourcesByKey.values()).sort(compareGraphSourceLocations);
}

export function isGraphSourceLocationsSorted(sources: readonly GraphSourceLocation[]): boolean {
    const canonicalSources = sortAndDedupeGraphSources(sources);
    return sources.length === canonicalSources.length
        && sources.every((source: GraphSourceLocation, index: number) => {
            const canonicalSource: GraphSourceLocation | undefined = canonicalSources[index];
            return canonicalSource !== undefined && areGraphSourceLocationsEqual(source, canonicalSource);
        });
}

export function isGraphNodesSorted(nodes: readonly KnowledgeGraphNode[]): boolean {
    return isSorted(nodes, compareGraphNodeIds);
}

export function isGraphEdgesSorted(edges: readonly KnowledgeGraphEdge[]): boolean {
    return isSorted(edges, compareGraphEdgeIds);
}

function normalizeGraphText(value: string): string {
    return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizeGraphSourceLocation(source: GraphSourceLocation): GraphSourceLocation {
    return {
        sourceFilePath: normalizeGraphPath(source.sourceFilePath),
        sourceDocumentId: createDocumentNodeId(source.sourceDocumentId),
        sourceKind: source.sourceKind,
        ...(source.targetFilePath ? { targetFilePath: normalizeGraphPath(source.targetFilePath) } : {}),
        chunkIds: Array.from(new Set(source.chunkIds.map((chunkId: string) => normalizeGraphText(chunkId))))
            .filter((chunkId: string) => chunkId.length > 0)
            .sort(compareStrings),
        ...(source.startLine === undefined ? {} : { startLine: source.startLine }),
        ...(source.startColumn === undefined ? {} : { startColumn: source.startColumn }),
        ...(source.endLine === undefined ? {} : { endLine: source.endLine }),
        ...(source.endColumn === undefined ? {} : { endColumn: source.endColumn }),
    };
}

function createGraphSourceLocationKey(source: GraphSourceLocation): string {
    return JSON.stringify({
        sourceFilePath: normalizeGraphPath(source.sourceFilePath),
        sourceDocumentId: createDocumentNodeId(source.sourceDocumentId),
        sourceKind: source.sourceKind,
        targetFilePath: source.targetFilePath ? normalizeGraphPath(source.targetFilePath) : null,
        chunkIds: Array.from(new Set(source.chunkIds.map((chunkId: string) => normalizeGraphText(chunkId))))
            .filter((chunkId: string) => chunkId.length > 0)
            .sort(compareStrings),
        startLine: source.startLine ?? null,
        startColumn: source.startColumn ?? null,
        endLine: source.endLine ?? null,
        endColumn: source.endColumn ?? null,
    });
}

function areGraphSourceLocationsEqual(left: GraphSourceLocation, right: GraphSourceLocation): boolean {
    return left.sourceFilePath === right.sourceFilePath
        && left.sourceDocumentId === right.sourceDocumentId
        && left.sourceKind === right.sourceKind
        && left.targetFilePath === right.targetFilePath
        && left.startLine === right.startLine
        && left.startColumn === right.startColumn
        && left.endLine === right.endLine
        && left.endColumn === right.endColumn
        && left.chunkIds.length === right.chunkIds.length
        && left.chunkIds.every((chunkId: string, index: number) => chunkId === right.chunkIds[index]);
}

function cloneGraphNode(node: KnowledgeGraphNode): KnowledgeGraphNode {
    if (node.type === "document") {
        return { ...node };
    }
    if (node.type === "section") {
        return {
            ...node,
            headingPath: [...node.headingPath],
            chunkIds: [...node.chunkIds],
            locator: cloneDocumentLocator(node.locator),
        };
    }
    return { ...node };
}

function cloneDocumentLocator<T extends { type: string }>(locator: T): T {
    return { ...locator };
}

function isSorted<T>(items: readonly T[], compare: (left: T, right: T) => number): boolean {
    for (let index = 1; index < items.length; index += 1) {
        const previous: T | undefined = items[index - 1];
        const current: T | undefined = items[index];
        if (previous && current && compare(previous, current) > 0) return false;
    }

    return true;
}

function compareStrings(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}
