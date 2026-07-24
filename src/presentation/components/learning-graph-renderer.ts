import type { LearningGraphEdge, LearningGraphNode } from "../../domain/learning-graph/learning-graph-types";

const WIDTH = 920;
const HEIGHT = 640;
const NODE_RADIUS = 6;
const REHEAT_LAYOUT_STEPS = 18;
const MAX_LAYOUT_PAIR_OPERATIONS = 4_500_000;

/** Fixed graph-canvas palette; it intentionally does not inherit a vault theme accent. */
const COLORS = {
    background: "#15171c",
    grid: "rgba(132, 145, 168, 0.16)",
    text: "#dde3ef",
    mutedText: "#8d98ad",
    node: "#7897ff",
    nodeDocument: "#a1a9b9",
    nodeTag: "#d8a55b",
    nodeSelected: "#9af0bf",
    nodeHovered: "#d4deff",
    nodeNeighbour: "#a8baff",
    edgeConfirmed: "rgba(111, 167, 255, 0.82)",
    edgeAutomatic: "rgba(190, 144, 255, 0.88)",
    edgeUser: "rgba(94, 221, 182, 0.9)",
    edgeStructural: "rgba(135, 145, 164, 0.42)",
    edgeMuted: "rgba(116, 126, 146, 0.12)",
} as const;

export interface LearningGraphRendererOptions {
    nodes: readonly LearningGraphNode[];
    edges: readonly LearningGraphEdge[];
    initialPinnedPositions?: Readonly<Record<string, LearningGraphPinnedPosition>>;
    accessibleTitle: string;
    selectedNodeId: string | null;
    selectedEdgeId: string | null;
    onSelectNode(nodeId: string): void;
    onSelectEdge(edgeId: string): void;
    onLayoutChanged?(pinnedPositions: Readonly<Record<string, LearningGraphPinnedPosition>>): void;
}

/** Only user-pinned coordinates are persisted; the rest remains deterministic. */
export interface LearningGraphPinnedPosition {
    x: number;
    y: number;
}

export interface LearningGraphPosition {
    x: number;
    y: number;
    vx: number;
    vy: number;
    pinned: boolean;
}

interface Transform { x: number; y: number; scale: number; }
interface PanDrag { kind: "pan"; x: number; y: number; transform: Transform; moved: boolean; }
interface NodeDrag { kind: "node"; nodeId: string; x: number; y: number; moved: boolean; }
type DragState = PanDrag | NodeDrag;

interface CommunityPlacement {
    hubId: string;
    hopsFromHub: number;
    centerX: number;
    centerY: number;
}

interface LayoutContext {
    degrees: Map<string, number>;
    communities: Map<string, CommunityPlacement>;
}

/**
 * A Canvas renderer that emulates the useful interaction model of Obsidian's
 * graph without coupling VaultCoach to its private GraphView implementation.
 * It settles a deterministic layout before first paint: a graph should remain
 * readable while users inspect it, rather than visibly fly into place.
 */
export class LearningGraphRenderer {
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly positions: Map<string, LearningGraphPosition>;
    private readonly degrees: ReadonlyMap<string, number>;
    private readonly layoutContext: LayoutContext;
    /** Logical Canvas viewport in CSS pixels; updated with the graph container. */
    private viewportWidth = WIDTH;
    private viewportHeight = HEIGHT;
    private resizeObserver: ResizeObserver | null = null;
    private transform: Transform = { x: 0, y: 0, scale: 1 };
    private selectedNodeId: string | null;
    private selectedEdgeId: string | null;
    private hoveredNodeId: string | null = null;
    private drag: DragState | null = null;
    private destroyed = false;

    constructor(private readonly root: HTMLElement, private readonly options: LearningGraphRendererOptions) {
        const layout = createLearningGraphLayout(options.nodes, options.edges);
        this.layoutContext = layout.context;
        this.degrees = layout.context.degrees;
        this.positions = layout.positions;
        this.restorePinnedPositions(options.initialPinnedPositions);
        this.selectedNodeId = options.selectedNodeId;
        this.selectedEdgeId = options.selectedEdgeId;
        this.canvas = document.createElement("canvas");
        this.canvas.classList.add("vault-coach-learning-map-canvas");
        this.canvas.setAttribute("role", "img");
        this.canvas.setAttribute("aria-label", options.accessibleTitle);
        const context = this.canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable.");
        this.context = context;
        this.root.appendChild(this.canvas);
        this.syncCanvasSize();
        this.resizeObserver = new ResizeObserver(() => {
            if (this.destroyed || !this.syncCanvasSize()) return;
            this.fit();
        });
        this.resizeObserver.observe(this.canvas);
        this.bindInteractions();
        this.fit();
    }

    fit(): void {
        const positions = Array.from(this.positions.values());
        if (positions.length === 0) return;
        const bounds = positions.reduce((result, position) => ({
            minX: Math.min(result.minX, position.x),
            maxX: Math.max(result.maxX, position.x),
            minY: Math.min(result.minY, position.y),
            maxY: Math.max(result.maxY, position.y),
        }), { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY });
        const padding = 46;
        const worldWidth = Math.max(90, bounds.maxX - bounds.minX + padding * 2);
        const worldHeight = Math.max(90, bounds.maxY - bounds.minY + padding * 2);
        const scale = clamp(Math.min(this.viewportWidth / worldWidth, this.viewportHeight / worldHeight), 0.12, 1.55);
        this.transform = {
            scale,
            x: this.viewportWidth / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
            y: this.viewportHeight / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
        };
        this.draw();
    }

    reheat(): void {
        if (this.destroyed) return;
        // Explicitly requested re-layout is intentionally a small synchronous
        // correction.  It avoids a large, attention-grabbing animation after
        // reopening a View while still resolving a dragged dense cluster.
        simulate(this.positions, this.options.edges, this.layoutContext, REHEAT_LAYOUT_STEPS);
        this.fit();
    }

    setSelection(nodeId: string | null, edgeId: string | null): void {
        this.selectedNodeId = nodeId;
        this.selectedEdgeId = edgeId;
        this.draw();
    }

    getPinnedPositions(): Record<string, LearningGraphPinnedPosition> {
        return Object.fromEntries(Array.from(this.positions.entries())
            .filter(([, position]) => position.pinned)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([nodeId, position]) => [nodeId, { x: position.x, y: position.y }]));
    }

    destroy(): void {
        this.destroyed = true;
        this.drag = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.root.empty();
    }

    private bindInteractions(): void {
        this.canvas.addEventListener("pointerdown", (event) => this.beginPointer(event));
        this.canvas.addEventListener("pointermove", (event) => this.movePointer(event));
        this.canvas.addEventListener("pointerup", (event) => this.endPointer(event));
        this.canvas.addEventListener("pointercancel", (event) => this.endPointer(event));
        this.canvas.addEventListener("pointerleave", () => {
            if (this.drag) return;
            this.hoveredNodeId = null;
            this.canvas.removeAttribute("title");
            this.draw();
        });
        this.canvas.addEventListener("wheel", (event) => this.zoom(event), { passive: false });
    }

    private beginPointer(event: PointerEvent): void {
        const position = this.toViewPoint(event);
        const nodeId = this.findNodeAt(position.x, position.y);
        if (nodeId) {
            this.drag = { kind: "node", nodeId, x: event.clientX, y: event.clientY, moved: false };
        } else {
            this.drag = { kind: "pan", x: event.clientX, y: event.clientY, transform: { ...this.transform }, moved: false };
        }
        this.canvas.setPointerCapture(event.pointerId);
    }

    private movePointer(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag) {
            const point = this.toViewPoint(event);
            const nodeId = this.findNodeAt(point.x, point.y);
            if (nodeId !== this.hoveredNodeId) {
                this.hoveredNodeId = nodeId;
                const node = nodeId ? this.options.nodes.find((item) => item.id === nodeId) : null;
                if (node?.label) this.canvas.title = node.label;
                else this.canvas.removeAttribute("title");
                this.draw();
            }
            return;
        }
        if (drag.kind === "pan") {
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            drag.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
            const rect = this.canvas.getBoundingClientRect();
            this.transform = {
                ...this.transform,
                x: drag.transform.x + dx * (this.viewportWidth / Math.max(1, rect.width)),
                y: drag.transform.y + dy * (this.viewportHeight / Math.max(1, rect.height)),
            };
            this.draw();
            return;
        }
        drag.moved ||= Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 3;
        if (!drag.moved) return;
        const point = this.toWorldPoint(event);
        const position = this.positions.get(drag.nodeId);
        if (!position) return;
        position.x = point.x;
        position.y = point.y;
        position.vx = 0;
        position.vy = 0;
        position.pinned = true;
        this.draw();
    }

    private endPointer(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag) return;
        this.drag = null;
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        if (drag.kind === "node" && drag.moved) {
            this.options.onLayoutChanged?.(this.getPinnedPositions());
            return;
        }
        if (drag.kind === "node" && !drag.moved) {
            this.options.onSelectNode(drag.nodeId);
            return;
        }
        if (drag.kind === "pan" && !drag.moved) {
            const point = this.toViewPoint(event);
            const edgeId = this.findEdgeAt(point.x, point.y);
            if (edgeId) this.options.onSelectEdge(edgeId);
        }
    }

    private zoom(event: WheelEvent): void {
        event.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (this.viewportWidth / Math.max(1, rect.width));
        const y = (event.clientY - rect.top) * (this.viewportHeight / Math.max(1, rect.height));
        const previous = this.transform.scale;
        const next = clamp(previous * learningGraphZoomMultiplier(event.deltaY, event.deltaMode, this.viewportHeight), 0.1, 4);
        const worldX = (x - this.transform.x) / previous;
        const worldY = (y - this.transform.y) / previous;
        this.transform = { scale: next, x: x - worldX * next, y: y - worldY * next };
        this.draw();
    }

    private draw(): void {
        const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
        this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        this.context.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
        this.context.fillStyle = COLORS.background;
        this.context.fillRect(0, 0, this.viewportWidth, this.viewportHeight);
        this.drawGrid();
        this.context.save();
        this.context.translate(this.transform.x, this.transform.y);
        this.context.scale(this.transform.scale, this.transform.scale);
        // Hover is a temporary exploration focus. It must take precedence over
        // an earlier click so a user can compare another neighbourhood without
        // losing their selected node in the inspector.
        const activeNodeId = this.hoveredNodeId ?? this.selectedNodeId;
        const neighbours = this.getNeighbourIds(activeNodeId);
        for (const edge of this.options.edges) this.drawEdge(edge, activeNodeId);
        for (const node of this.options.nodes) this.drawNode(node, activeNodeId, neighbours);
        this.context.restore();
    }

    private drawGrid(): void {
        const context = this.context;
        context.save();
        context.fillStyle = COLORS.grid;
        // A sparse dot field offers orientation without competing with graph
        // edges; full square grid lines made dense candidate maps look like a
        // debugging overlay rather than an Obsidian-style graph.
        for (let x = 14; x <= this.viewportWidth; x += 28) {
            for (let y = 14; y <= this.viewportHeight; y += 28) {
                context.fillRect(x, y, 1, 1);
            }
        }
        context.restore();
    }

    private drawEdge(edge: LearningGraphEdge, activeNodeId: string | null): void {
        const source = this.positions.get(edge.sourceNodeId);
        const target = this.positions.get(edge.targetNodeId);
        if (!source || !target) return;
        const adjacent = activeNodeId !== null && (edge.sourceNodeId === activeNodeId || edge.targetNodeId === activeNodeId);
        const selected = edge.id === this.selectedEdgeId;
        const muted = activeNodeId !== null && !adjacent && !selected;
        const context = this.context;
        const { sourceX, sourceY, targetX, targetY, angle } = edgeEndpoints(
            source,
            target,
            edge.directed,
            this.nodeRadius(edge.sourceNodeId),
            this.nodeRadius(edge.targetNodeId),
        );
        context.save();
        if (edge.trust === "automatic" && !adjacent && !selected) context.globalAlpha = 0.8;
        context.strokeStyle = muted ? COLORS.edgeMuted : edgeColor(edge);
        context.lineWidth = selected ? 3.4 : adjacent ? 2.8 : edge.trust === "automatic" ? 1.1 : 1.8;
        if (edge.trust === "automatic") context.setLineDash([7, 6]);
        context.beginPath();
        context.moveTo(sourceX, sourceY);
        context.lineTo(targetX, targetY);
        context.stroke();
        context.setLineDash([]);
        // A screen full of candidate arrowheads is visual noise. Direction is
        // always shown for learning facts; automatic candidates reveal it when
        // focused or selected and remain inspectable in the side panel.
        if (edge.directed && (edge.trust !== "automatic" || adjacent || selected)) {
            context.fillStyle = muted ? COLORS.edgeMuted : edgeColor(edge);
            drawArrow(context, targetX, targetY, angle, selected ? 8 : 6);
        }
        context.restore();
    }

    private drawNode(node: LearningGraphNode, activeNodeId: string | null, neighbours: ReadonlySet<string>): void {
        const position = this.positions.get(node.id);
        if (!position) return;
        const selected = node.id === this.selectedNodeId;
        const hovered = node.id === this.hoveredNodeId;
        const neighbour = neighbours.has(node.id);
        const muted = activeNodeId !== null && node.id !== activeNodeId && !neighbour;
        const radius = this.nodeRadius(node.id) + (selected || hovered ? 2 : 0);
        const context = this.context;
        context.save();
        context.globalAlpha = muted ? 0.26 : 1;
        context.fillStyle = selected ? COLORS.nodeSelected : hovered ? COLORS.nodeHovered : neighbour ? COLORS.nodeNeighbour : nodeColor(node);
        if (hovered) {
            context.shadowColor = COLORS.nodeHovered;
            context.shadowBlur = 15;
        } else if (neighbour) {
            context.shadowColor = COLORS.nodeNeighbour;
            context.shadowBlur = 8;
        }
        context.beginPath();
        context.arc(position.x, position.y, radius, 0, Math.PI * 2);
        context.fill();
        context.lineWidth = selected || hovered ? 2.6 : neighbour ? 2 : 1.2;
        context.strokeStyle = COLORS.background;
        context.stroke();
        if (position.pinned) {
            context.fillStyle = COLORS.text;
            context.beginPath();
            context.arc(position.x + radius - 2, position.y - radius + 2, 2, 0, Math.PI * 2);
            context.fill();
        }
        // Labels fade in across a zoom range instead of appearing abruptly.
        // Active neighbourhood labels remain immediately readable at any zoom.
        const zoomLabelAlpha = smoothStep(0.82, 1.5, this.transform.scale);
        const contextual = selected || hovered || neighbour;
        const showLabel = contextual || zoomLabelAlpha > 0;
        if (showLabel) {
            context.shadowBlur = 0;
            context.globalAlpha = (muted ? 0.26 : 1) * (contextual ? 1 : zoomLabelAlpha);
            context.fillStyle = muted ? COLORS.mutedText : COLORS.text;
            // Match the on-canvas label to the CSS font used by the legend.
            // It is converted from CSS pixels to the current Canvas world
            // coordinates before the graph transform is applied, so neither
            // graph zoom nor a narrow Obsidian pane changes its screen size.
            const legendFontSize = this.legendFontSizeInWorldUnits();
            context.font = `650 ${legendFontSize / Math.max(0.1, this.transform.scale)}px Inter, ui-sans-serif, system-ui, sans-serif`;
            context.textAlign = "center";
            context.textBaseline = "bottom";
            context.lineJoin = "round";
            context.strokeStyle = COLORS.background;
            context.lineWidth = (2.3 * this.viewportWidth / Math.max(1, this.canvas.getBoundingClientRect().width)) / Math.max(0.1, this.transform.scale);
            context.strokeText(truncate(node.label, 19), position.x, position.y - radius - 7);
            context.fillText(truncate(node.label, 19), position.x, position.y - radius - 7);
        }
        context.restore();
    }

    private legendFontSizeInWorldUnits(): number {
        // The legend is declared as 0.78rem in styles.css.  Read the active
        // root size so users who increase Obsidian's interface font continue
        // to see matching labels rather than a second, unrelated scale.
        const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
        const displayWidth = Math.max(1, this.canvas.getBoundingClientRect().width);
        return rootFontSize * 0.78 * (this.viewportWidth / displayWidth);
    }

    /**
     * Keep the backing store and logical coordinate system equal to the CSS
     * viewport. CSS may make the graph taller than its initial 23:16 shape;
     * drawing into a matching backing store preserves circular nodes and gives
     * `fit()` genuinely more vertical view space instead of stretching pixels.
     */
    private syncCanvasSize(): boolean {
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width || WIDTH));
        const height = Math.max(1, Math.round(rect.height || HEIGHT));
        const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
        const backingWidth = Math.round(width * pixelRatio);
        const backingHeight = Math.round(height * pixelRatio);
        if (width === this.viewportWidth && height === this.viewportHeight
            && this.canvas.width === backingWidth && this.canvas.height === backingHeight) return false;
        this.viewportWidth = width;
        this.viewportHeight = height;
        this.canvas.width = backingWidth;
        this.canvas.height = backingHeight;
        return true;
    }

    private restorePinnedPositions(value: Readonly<Record<string, LearningGraphPinnedPosition>> | undefined): void {
        const positions = normalizeLearningGraphPinnedPositions(value, Array.from(this.positions.keys()));
        for (const [nodeId, pinned] of Object.entries(positions)) {
            const position = this.positions.get(nodeId);
            if (!position) continue;
            position.x = pinned.x;
            position.y = pinned.y;
            position.vx = 0;
            position.vy = 0;
            position.pinned = true;
        }
    }

    private getNeighbourIds(activeNodeId: string | null): Set<string> {
        const neighbours = new Set<string>();
        if (!activeNodeId) return neighbours;
        for (const edge of this.options.edges) {
            if (edge.sourceNodeId === activeNodeId) neighbours.add(edge.targetNodeId);
            if (edge.targetNodeId === activeNodeId) neighbours.add(edge.sourceNodeId);
        }
        return neighbours;
    }

    private findNodeAt(viewX: number, viewY: number): string | null {
        const x = (viewX - this.transform.x) / this.transform.scale;
        const y = (viewY - this.transform.y) / this.transform.scale;
        for (const [nodeId, position] of Array.from(this.positions.entries()).reverse()) {
            const radius = this.nodeRadius(nodeId) + 5 / this.transform.scale;
            if (Math.hypot(position.x - x, position.y - y) <= radius) return nodeId;
        }
        return null;
    }

    private findEdgeAt(viewX: number, viewY: number): string | null {
        const x = (viewX - this.transform.x) / this.transform.scale;
        const y = (viewY - this.transform.y) / this.transform.scale;
        const threshold = 6 / this.transform.scale;
        for (const edge of this.options.edges) {
            const source = this.positions.get(edge.sourceNodeId);
            const target = this.positions.get(edge.targetNodeId);
            if (!source || !target) continue;
            if (distanceToSegment(x, y, source.x, source.y, target.x, target.y) <= threshold) return edge.id;
        }
        return null;
    }

    private toViewPoint(event: PointerEvent): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * (this.viewportWidth / Math.max(1, rect.width)),
            y: (event.clientY - rect.top) * (this.viewportHeight / Math.max(1, rect.height)),
        };
    }

    private toWorldPoint(event: PointerEvent): { x: number; y: number } {
        const point = this.toViewPoint(event);
        return {
            x: (point.x - this.transform.x) / this.transform.scale,
            y: (point.y - this.transform.y) / this.transform.scale,
        };
    }

    private nodeRadius(nodeId: string): number {
        return visualNodeRadius(this.degrees.get(nodeId) ?? 0);
    }
}

/** Pure deterministic layout for tests, screenshots, and frozen initial views. */
export function createLearningGraphForceLayout(
    nodes: readonly LearningGraphNode[],
    edges: readonly Pick<LearningGraphEdge, "sourceNodeId" | "targetNodeId">[],
): Map<string, LearningGraphPosition> {
    return createLearningGraphLayout(nodes, edges).positions;
}

/** Degree is a first-class visual signal: hub nodes are deliberately larger. */
export function learningGraphNodeRadiusForDegree(degree: number): number {
    // A hub should read as a hub at overview zoom.  The previous 18px cap was
    // too subtle once the graph contained many automatic candidate edges.
    return NODE_RADIUS + Math.min(32, Math.sqrt(Math.max(0, degree)) * 6.4);
}

/** Validates persisted UI coordinates without trusting workspace state blindly. */
export function normalizeLearningGraphPinnedPositions(
    value: unknown,
    availableNodeIds?: readonly string[],
): Record<string, LearningGraphPinnedPosition> {
    if (!isPlainRecord(value)) return {};
    const available = availableNodeIds ? new Set(availableNodeIds) : null;
    const positions: Record<string, LearningGraphPinnedPosition> = {};
    for (const [nodeId, position] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
        if (available && !available.has(nodeId)) continue;
        if (!isPlainRecord(position) || typeof position.x !== "number" || typeof position.y !== "number") continue;
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
        positions[nodeId] = { x: position.x, y: position.y };
        if (Object.keys(positions).length >= 500) break;
    }
    return positions;
}

/**
 * Trackpads emit many small wheel deltas. Scaling from the delta magnitude
 * avoids turning every tiny gesture into the old fixed 12% zoom jump.
 */
export function learningGraphZoomMultiplier(deltaY: number, deltaMode = 0, pageHeight = HEIGHT): number {
    const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageHeight : deltaY;
    return Math.exp(-clamp(pixels, -180, 180) * 0.0011);
}

function createLearningGraphLayout(
    nodes: readonly LearningGraphNode[],
    edges: readonly Pick<LearningGraphEdge, "sourceNodeId" | "targetNodeId">[],
): { context: LayoutContext; positions: Map<string, LearningGraphPosition> } {
    const context = createLayoutContext(nodes, edges);
    const positions = createInitialPositions(nodes, context);
    simulate(positions, edges, context, settledLayoutSteps(nodes.length));
    return { context, positions };
}

function settledLayoutSteps(nodeCount: number): number {
    const pairs = Math.max(1, (nodeCount * Math.max(0, nodeCount - 1)) / 2);
    // Each step has one repulsion and two collision passes. This keeps the
    // opening cost bounded at the 500-node local ceiling without weakening the
    // 150-node overview that users see most often.
    return clamp(Math.floor(MAX_LAYOUT_PAIR_OPERATIONS / (pairs * 3)), 20, 150);
}

function createInitialPositions(nodes: readonly LearningGraphNode[], context: LayoutContext): Map<string, LearningGraphPosition> {
    const byHub = new Map<string, LearningGraphNode[]>();
    for (const node of nodes) {
        const placement = context.communities.get(node.id);
        if (!placement) continue;
        const members = byHub.get(placement.hubId) ?? [];
        members.push(node);
        byHub.set(placement.hubId, members);
    }
    const positions = new Map<string, LearningGraphPosition>();
    for (const [hubId, members] of byHub) {
        const hubPlacement = context.communities.get(hubId);
        if (!hubPlacement) continue;
        const ordered = [...members].sort((left, right) => (
            (context.communities.get(left.id)?.hopsFromHub ?? 0) - (context.communities.get(right.id)?.hopsFromHub ?? 0)
            || (context.degrees.get(right.id) ?? 0) - (context.degrees.get(left.id) ?? 0)
            || left.id.localeCompare(right.id)
        ));
        for (let index = 0; index < ordered.length; index += 1) {
            const node = ordered[index];
            if (!node) continue;
            const placement = context.communities.get(node.id);
            if (!placement) continue;
            const degree = context.degrees.get(node.id) ?? 0;
            const angle = index * 2.399963229728653 + (hash(node.id) % 23) * 0.017;
            const localRank = Math.max(0, index - 1);
            const radius = node.id === hubId
                ? 0
                : 54 * Math.max(1, placement.hopsFromHub)
                    + Math.sqrt(localRank) * 26
                    + Math.sqrt(degree) * 10;
            positions.set(node.id, {
                x: hubPlacement.centerX + Math.cos(angle) * radius,
                y: hubPlacement.centerY + Math.sin(angle) * radius * 0.82,
                vx: 0,
                vy: 0,
                pinned: false,
            });
        }
    }
    return positions;
}

function createLayoutContext(
    nodes: readonly Pick<LearningGraphNode, "id">[],
    edges: readonly Pick<LearningGraphEdge, "sourceNodeId" | "targetNodeId">[],
): LayoutContext {
    const degrees = createDegreeMap(nodes, edges);
    const neighbours = createNeighbourMap(nodes, edges);
    const components = createConnectedComponents(nodes, neighbours);
    const provisional = new Map<string, { hubId: string; hopsFromHub: number }>();
    for (const component of components) {
        const hubs = selectCommunityHubs(component, neighbours, degrees);
        const assignments = assignToHubs(component, hubs, neighbours);
        for (const [nodeId, assignment] of assignments) provisional.set(nodeId, assignment);
    }
    const hubIds = Array.from(new Set(Array.from(provisional.values(), (placement) => placement.hubId)))
        .sort((left, right) => (degrees.get(right) ?? 0) - (degrees.get(left) ?? 0) || left.localeCompare(right));
    const centers = createGalaxyCenters(hubIds);
    const communities = new Map<string, CommunityPlacement>();
    for (const [nodeId, placement] of provisional) {
        const center = centers.get(placement.hubId) ?? { x: 0, y: 0 };
        communities.set(nodeId, { ...placement, centerX: center.x, centerY: center.y });
    }
    return { degrees, communities };
}

function createGalaxyCenters(hubIds: readonly string[]): Map<string, { x: number; y: number }> {
    const centers = new Map<string, { x: number; y: number }>();
    if (hubIds.length === 1) {
        const hubId = hubIds[0];
        if (hubId) centers.set(hubId, { x: 0, y: 0 });
        return centers;
    }
    const maximumRadius = 108 + Math.min(260, Math.sqrt(hubIds.length) * 34);
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < hubIds.length; index += 1) {
        const hubId = hubIds[index];
        if (!hubId) continue;
        // High-degree hubs are sorted first and begin near the centre.  The
        // remaining communities follow a sunflower spiral through one broad
        // disk, so a full map reads as one native-style graph cloud rather
        // than as a ring of remote, unrelated constellations.
        const ratio = hubIds.length === 1 ? 0 : Math.sqrt(index / Math.max(1, hubIds.length - 1));
        const radius = maximumRadius * ratio;
        const angle = goldenAngle * index + (hash(hubId) % 17) * 0.021;
        centers.set(hubId, {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius * 0.82,
        });
    }
    return centers;
}

function createNeighbourMap(
    nodes: readonly Pick<LearningGraphNode, "id">[],
    edges: readonly Pick<LearningGraphEdge, "sourceNodeId" | "targetNodeId">[],
): Map<string, string[]> {
    const neighbours = new Map(nodes.map((node) => [node.id, [] as string[]]));
    for (const edge of edges) {
        if (!neighbours.has(edge.sourceNodeId) || !neighbours.has(edge.targetNodeId)) continue;
        neighbours.get(edge.sourceNodeId)?.push(edge.targetNodeId);
        neighbours.get(edge.targetNodeId)?.push(edge.sourceNodeId);
    }
    for (const values of neighbours.values()) {
        values.sort((left, right) => left.localeCompare(right));
        for (let index = values.length - 1; index > 0; index -= 1) {
            if (values[index] === values[index - 1]) values.splice(index, 1);
        }
    }
    return neighbours;
}

function createConnectedComponents(
    nodes: readonly Pick<LearningGraphNode, "id">[],
    neighbours: ReadonlyMap<string, readonly string[]>,
): string[][] {
    const remaining = new Set(nodes.map((node) => node.id));
    const components: string[][] = [];
    while (remaining.size > 0) {
        const start = Array.from(remaining).sort((left, right) => left.localeCompare(right))[0];
        if (!start) break;
        remaining.delete(start);
        const component = [start];
        const queue = [start];
        while (queue.length > 0) {
            const nodeId = queue.shift();
            if (!nodeId) continue;
            for (const neighbour of neighbours.get(nodeId) ?? []) {
                if (!remaining.delete(neighbour)) continue;
                component.push(neighbour);
                queue.push(neighbour);
            }
        }
        components.push(component.sort((left, right) => left.localeCompare(right)));
    }
    return components;
}

function selectCommunityHubs(
    component: readonly string[],
    neighbours: ReadonlyMap<string, readonly string[]>,
    degrees: ReadonlyMap<string, number>,
): string[] {
    const target = Math.max(1, Math.min(8, Math.round(Math.sqrt(component.length) / 2)));
    const ordered = [...component].sort((left, right) => (degrees.get(right) ?? 0) - (degrees.get(left) ?? 0) || left.localeCompare(right));
    const hubs: string[] = [];
    for (const candidate of ordered) {
        if (hubs.length >= target) break;
        if (hubs.length === 0 || hubs.every((hub) => !withinTwoHops(candidate, hub, neighbours))) hubs.push(candidate);
    }
    // A very dense component may put all high-degree nodes within two hops.
    // Fill remaining seeds deterministically rather than collapsing it into
    // one giant star.
    for (const candidate of ordered) {
        if (hubs.length >= target) break;
        if (!hubs.includes(candidate)) hubs.push(candidate);
    }
    return hubs.length > 0 ? hubs : [component[0]!];
}

function withinTwoHops(start: string, target: string, neighbours: ReadonlyMap<string, readonly string[]>): boolean {
    if (start === target) return true;
    const first = neighbours.get(start) ?? [];
    if (first.includes(target)) return true;
    return first.some((nodeId) => (neighbours.get(nodeId) ?? []).includes(target));
}

function assignToHubs(
    component: readonly string[],
    hubs: readonly string[],
    neighbours: ReadonlyMap<string, readonly string[]>,
): Map<string, { hubId: string; hopsFromHub: number }> {
    const assignments = new Map<string, { hubId: string; hopsFromHub: number }>();
    const queue = hubs.slice().sort((left, right) => left.localeCompare(right));
    for (const hubId of queue) assignments.set(hubId, { hubId, hopsFromHub: 0 });
    for (let index = 0; index < queue.length; index += 1) {
        const nodeId = queue[index];
        if (!nodeId) continue;
        const current = assignments.get(nodeId);
        if (!current) continue;
        for (const neighbour of neighbours.get(nodeId) ?? []) {
            const existing = assignments.get(neighbour);
            const next = { hubId: current.hubId, hopsFromHub: current.hopsFromHub + 1 };
            if (existing && (existing.hopsFromHub < next.hopsFromHub
                || (existing.hopsFromHub === next.hopsFromHub && existing.hubId.localeCompare(next.hubId) <= 0))) continue;
            assignments.set(neighbour, next);
            queue.push(neighbour);
        }
    }
    for (const nodeId of component) {
        if (!assignments.has(nodeId)) assignments.set(nodeId, { hubId: hubs[0]!, hopsFromHub: 0 });
    }
    return assignments;
}

function simulate(
    positions: Map<string, LearningGraphPosition>,
    edges: readonly Pick<LearningGraphEdge, "sourceNodeId" | "targetNodeId">[],
    layout: LayoutContext,
    steps: number,
): void {
    const visibleEdges = edges.filter((edge) => positions.has(edge.sourceNodeId) && positions.has(edge.targetNodeId));
    const degrees = layout.degrees;
    for (let step = 0; step < steps; step += 1) {
        const points = Array.from(positions.entries());
        for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
            const [leftId, left] = points[leftIndex] ?? [];
            if (!leftId || !left) continue;
            for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
                const [rightId, right] = points[rightIndex] ?? [];
                if (!rightId || !right) continue;
                const direction = hash(`${leftId}\u0000${rightId}`) % 2 === 0 ? 1 : -1;
                const dx = left.x - right.x || direction * 0.01;
                const dy = left.y - right.y || -direction * 0.01;
                const squared = Math.max(25, dx * dx + dy * dy);
                const distance = Math.sqrt(squared);
                const minimumDistance = layoutNodeRadius(degrees.get(leftId) ?? 0)
                    + layoutNodeRadius(degrees.get(rightId) ?? 0) + 7;
                const collision = distance < minimumDistance ? (minimumDistance - distance) * 1.32 : 0;
                const degreeWeight = 1 + Math.min(1.8, Math.sqrt((degrees.get(leftId) ?? 0) + (degrees.get(rightId) ?? 0)) * 0.12);
                const force = (5_800 / squared) * degreeWeight + collision;
                const forceX = (dx / distance) * force;
                const forceY = (dy / distance) * force;
                if (!left.pinned) { left.vx += forceX; left.vy += forceY; }
                if (!right.pinned) { right.vx -= forceX; right.vy -= forceY; }
            }
        }
        for (const edge of visibleEdges) {
            const source = positions.get(edge.sourceNodeId);
            const target = positions.get(edge.targetNodeId);
            if (!source || !target) continue;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            const sourceDegree = degrees.get(edge.sourceNodeId) ?? 0;
            const targetDegree = degrees.get(edge.targetNodeId) ?? 0;
            const sourceCommunity = layout.communities.get(edge.sourceNodeId)?.hubId;
            const targetCommunity = layout.communities.get(edge.targetNodeId)?.hubId;
            const crossesGalaxies = sourceCommunity !== targetCommunity;
            const desiredLength = (crossesGalaxies ? 176 : 88)
                + Math.min(crossesGalaxies ? 72 : 82, Math.sqrt(Math.max(sourceDegree, targetDegree)) * 14);
            const force = (distance - desiredLength) * (crossesGalaxies ? 0.011 : 0.021);
            const forceX = (dx / distance) * force;
            const forceY = (dy / distance) * force;
            if (!source.pinned) { source.vx += forceX; source.vy += forceY; }
            if (!target.pinned) { target.vx -= forceX; target.vy -= forceY; }
        }
        for (const [nodeId, position] of positions) {
            if (position.pinned) continue;
            const community = layout.communities.get(nodeId);
            if (community) {
                // Community centres form a loose circular cloud. This is an
                // attraction in world coordinates, not a rectangular boundary:
                // users can pan anywhere and Fit graph reframes it.
                position.vx += (community.centerX - position.x) * 0.0028;
                position.vy += (community.centerY - position.y) * 0.0028;
            }
            // A very weak global gravity reins in disconnected source nodes
            // after collision resolution without forcing any hard boundary.
            position.vx -= position.x * 0.00065;
            position.vy -= position.y * 0.00065;
            position.vx *= 0.79;
            position.vy *= 0.79;
            position.x += position.vx;
            position.y += position.vy;
        }
        resolveCollisions(positions, degrees);
    }
}

function createDegreeMap(
    nodes: readonly Pick<LearningGraphNode, "id">[],
    edges: readonly Pick<LearningGraphEdge, "sourceNodeId" | "targetNodeId">[],
): Map<string, number> {
    const degrees = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
        if (degrees.has(edge.sourceNodeId)) degrees.set(edge.sourceNodeId, (degrees.get(edge.sourceNodeId) ?? 0) + 1);
        if (degrees.has(edge.targetNodeId)) degrees.set(edge.targetNodeId, (degrees.get(edge.targetNodeId) ?? 0) + 1);
    }
    return degrees;
}

function visualNodeRadius(degree: number): number {
    return learningGraphNodeRadiusForDegree(degree);
}

function layoutNodeRadius(degree: number): number {
    // Reserve extra whitespace around hubs so arrow fans do not turn into a
    // single unreadable knot. This invisible radius is intentionally larger
    // than the rendered node circle.
    return visualNodeRadius(degree) + 18 + Math.min(24, Math.sqrt(Math.max(0, degree)) * 3.4);
}

function resolveCollisions(positions: Map<string, LearningGraphPosition>, degrees: ReadonlyMap<string, number>): void {
    const points = Array.from(positions.entries());
    // A direct positional pass makes the collision constraint dependable even
    // for a star graph where springs pull many leaves toward one hub.
    for (let pass = 0; pass < 2; pass += 1) {
        for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
            const [leftId, left] = points[leftIndex] ?? [];
            if (!leftId || !left) continue;
            for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
                const [rightId, right] = points[rightIndex] ?? [];
                if (!rightId || !right) continue;
                const dx = left.x - right.x || (hash(`${leftId}\u0000${rightId}`) % 2 === 0 ? 0.01 : -0.01);
                const dy = left.y - right.y || (hash(`${rightId}\u0000${leftId}`) % 2 === 0 ? 0.01 : -0.01);
                const distance = Math.max(0.01, Math.hypot(dx, dy));
                const minimumDistance = layoutNodeRadius(degrees.get(leftId) ?? 0)
                    + layoutNodeRadius(degrees.get(rightId) ?? 0) + 7;
                if (distance >= minimumDistance) continue;
                const correction = (minimumDistance - distance) / 2;
                const correctionX = (dx / distance) * correction;
                const correctionY = (dy / distance) * correction;
                if (!left.pinned) {
                    left.x += correctionX;
                    left.y += correctionY;
                }
                if (!right.pinned) {
                    right.x -= correctionX;
                    right.y -= correctionY;
                }
            }
        }
    }
}

function edgeEndpoints(
    source: LearningGraphPosition,
    target: LearningGraphPosition,
    directed: boolean,
    sourceRadius: number,
    targetRadius: number,
) {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const sourceOffset = sourceRadius + 2;
    const targetOffset = targetRadius + (directed ? 9 : 2);
    return {
        sourceX: source.x + (dx / distance) * sourceOffset,
        sourceY: source.y + (dy / distance) * sourceOffset,
        targetX: target.x - (dx / distance) * targetOffset,
        targetY: target.y - (dy / distance) * targetOffset,
        angle: Math.atan2(dy, dx),
    };
}

function drawArrow(context: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number): void {
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(-size, -size * 0.55);
    context.lineTo(-size, size * 0.55);
    context.closePath();
    context.fill();
    context.restore();
}

function edgeColor(edge: LearningGraphEdge): string {
    if (edge.trust === "automatic") return COLORS.edgeAutomatic;
    if (edge.origin === "user") return COLORS.edgeUser;
    if (edge.trust === "structural") return COLORS.edgeStructural;
    return COLORS.edgeConfirmed;
}

function nodeColor(node: LearningGraphNode): string {
    if (node.kind === "document" || node.kind === "section") return COLORS.nodeDocument;
    if (node.kind === "tag") return COLORS.nodeTag;
    return COLORS.node;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
    const ratio = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
    return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

function truncate(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function smoothStep(start: number, end: number, value: number): number {
    const ratio = clamp((value - start) / Math.max(0.001, end - start), 0, 1);
    return ratio * ratio * (3 - 2 * ratio);
}

function hash(value: string): number {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
    }
    return result >>> 0;
}
