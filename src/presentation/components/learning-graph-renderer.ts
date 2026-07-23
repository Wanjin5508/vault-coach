import type { LearningGraphEdge, LearningGraphNode } from "../../domain/learning-graph/learning-graph-types";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const WIDTH = 920;
const HEIGHT = 640;
const NODE_RADIUS = 11;
const MIN_NODE_DISTANCE = 48;
let instanceSequence = 0;

export interface LearningGraphRendererOptions {
    nodes: readonly LearningGraphNode[];
    edges: readonly LearningGraphEdge[];
    accessibleTitle: string;
    selectedNodeId: string | null;
    selectedEdgeId: string | null;
    onSelectNode(nodeId: string): void;
    onSelectEdge(edgeId: string): void;
}

interface Point { x: number; y: number; vx: number; vy: number; }
interface Transform { x: number; y: number; scale: number; }
interface PanDragState { kind: "pan"; x: number; y: number; transform: Transform; moved: boolean; }
interface NodeDragState { kind: "node"; nodeId: string; x: number; y: number; moved: boolean; }
type DragState = PanDragState | NodeDragState;

/**
 * SVG renderer for the bounded Learning Map projection.
 *
 * The force layout deliberately runs only once, synchronously, against the
 * projection's existing node budget (at most 150 nodes). It is therefore a
 * visual layout calculation, not a semantic graph calculation: it neither
 * changes graph facts nor performs unbounded work while a user explores.
 */
export class LearningGraphRenderer {
    private readonly svg: SVGSVGElement;
    private readonly viewport: SVGGElement;
    private readonly positions: Map<string, Point>;
    private readonly nodeEls = new Map<string, SVGGElement>();
    private readonly edgeEls = new Map<string, SVGLineElement>();
    private readonly directedMarkerId: string;
    private transform: Transform = { x: 0, y: 0, scale: 1 };
    private drag: DragState | null = null;
    private hoveredNodeId: string | null = null;
    private selectedNodeId: string | null;
    private selectedEdgeId: string | null;

    constructor(private readonly root: HTMLElement, private readonly options: LearningGraphRendererOptions) {
        this.positions = createLearningGraphForceLayout(options.nodes, options.edges);
        this.selectedNodeId = options.selectedNodeId;
        this.selectedEdgeId = options.selectedEdgeId;
        this.directedMarkerId = `vault-coach-learning-map-arrow-${++instanceSequence}`;
        this.svg = createSvg("svg");
        this.svg.classList.add("vault-coach-learning-map-renderer");
        this.svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
        this.svg.setAttribute("role", "img");
        this.viewport = createSvg("g");
        this.root.appendChild(this.svg);
        this.render();
    }

    fit(): void {
        const points = Array.from(this.positions.values());
        if (points.length === 0) return;
        const bounds = points.reduce((result, point) => ({
            minX: Math.min(result.minX, point.x),
            maxX: Math.max(result.maxX, point.x),
            minY: Math.min(result.minY, point.y),
            maxY: Math.max(result.maxY, point.y),
        }), { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY });
        const padding = 54;
        const worldWidth = Math.max(80, bounds.maxX - bounds.minX + padding * 2);
        const worldHeight = Math.max(80, bounds.maxY - bounds.minY + padding * 2);
        const scale = clamp(Math.min(WIDTH / worldWidth, HEIGHT / worldHeight), 0.55, 1.5);
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        this.transform = {
            scale,
            x: WIDTH / 2 - centerX * scale,
            y: HEIGHT / 2 - centerY * scale,
        };
        this.applyTransform();
    }

    setSelection(nodeId: string | null, edgeId: string | null): void {
        this.selectedNodeId = nodeId;
        this.selectedEdgeId = edgeId;
        this.updateEmphasis();
    }

    destroy(): void {
        this.drag = null;
        this.nodeEls.clear();
        this.edgeEls.clear();
        this.root.empty();
    }

    private render(): void {
        // Obsidian tooltip delegation assumes HTMLElement.isShown(). SVG nodes
        // are not HTMLElements, so native <title> is intentionally used instead
        // of aria-label/data-tooltip attributes on SVG descendants.
        const title = createSvg("title");
        title.textContent = this.options.accessibleTitle;
        this.svg.appendChild(title);
        this.renderArrowMarker();
        const background = createSvg("rect");
        background.setAttribute("class", "vault-coach-learning-map-background");
        background.setAttribute("width", String(WIDTH));
        background.setAttribute("height", String(HEIGHT));
        this.svg.appendChild(background);
        this.svg.appendChild(this.viewport);
        for (const edge of this.options.edges) this.drawEdge(edge);
        for (const node of this.options.nodes) this.drawNode(node);
        this.updateEmphasis();
        this.fit();
        background.addEventListener("pointerdown", (event) => this.beginPan(event));
        this.svg.addEventListener("pointermove", (event) => this.movePointer(event));
        this.svg.addEventListener("pointerup", (event) => this.endPointer(event));
        this.svg.addEventListener("pointercancel", (event) => this.endPointer(event));
        this.svg.addEventListener("wheel", (event) => this.zoom(event), { passive: false });
    }

    private renderArrowMarker(): void {
        const defs = createSvg("defs");
        const marker = createSvg("marker");
        marker.setAttribute("id", this.directedMarkerId);
        marker.setAttribute("viewBox", "0 0 8 8");
        marker.setAttribute("refX", "7");
        marker.setAttribute("refY", "4");
        marker.setAttribute("markerWidth", "5");
        marker.setAttribute("markerHeight", "5");
        marker.setAttribute("orient", "auto");
        marker.setAttribute("markerUnits", "strokeWidth");
        const path = createSvg("path");
        path.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
        path.setAttribute("class", "vault-coach-learning-map-arrow");
        marker.appendChild(path);
        defs.appendChild(marker);
        this.svg.appendChild(defs);
    }

    private drawEdge(edge: LearningGraphEdge): void {
        if (!this.positions.has(edge.sourceNodeId) || !this.positions.has(edge.targetNodeId)) return;
        const line = createSvg("line");
        line.setAttribute("class", `vault-coach-learning-map-edge is-${edge.origin}${edge.directed ? " is-directed" : ""}`);
        if (edge.directed) line.setAttribute("marker-end", `url(#${this.directedMarkerId})`);
        line.setAttribute("tabindex", "0");
        const title = createSvg("title");
        title.textContent = `${edge.sourceNodeId} ${edge.directed ? "→" : "—"} ${edge.type} ${edge.targetNodeId}`;
        line.appendChild(title);
        line.addEventListener("click", (event) => { event.stopPropagation(); this.options.onSelectEdge(edge.id); });
        line.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.options.onSelectEdge(edge.id); }
        });
        this.viewport.appendChild(line);
        this.edgeEls.set(edge.id, line);
        this.updateEdge(edge);
    }

    private drawNode(node: LearningGraphNode): void {
        const position = this.positions.get(node.id);
        if (!position) return;
        const group = createSvg("g");
        group.setAttribute("class", `vault-coach-learning-map-node is-${node.kind}`);
        group.setAttribute("tabindex", "0");
        const circle = createSvg("circle");
        circle.setAttribute("r", String(NODE_RADIUS));
        const label = createSvg("text");
        label.setAttribute("y", "-17");
        label.setAttribute("text-anchor", "middle");
        label.textContent = truncate(node.label, 18);
        const title = createSvg("title");
        title.textContent = node.label;
        group.appendChild(circle);
        group.appendChild(label);
        group.appendChild(title);
        group.addEventListener("pointerdown", (event) => this.beginNodeDrag(event, node.id));
        group.addEventListener("mouseenter", () => { this.hoveredNodeId = node.id; this.updateEmphasis(); });
        group.addEventListener("mouseleave", () => { if (this.hoveredNodeId === node.id) this.hoveredNodeId = null; this.updateEmphasis(); });
        group.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.options.onSelectNode(node.id); }
        });
        this.viewport.appendChild(group);
        this.nodeEls.set(node.id, group);
        this.updateNode(node.id);
    }

    private beginPan(event: PointerEvent): void {
        this.drag = { kind: "pan", x: event.clientX, y: event.clientY, transform: { ...this.transform }, moved: false };
        this.svg.setPointerCapture(event.pointerId);
    }

    private beginNodeDrag(event: PointerEvent, nodeId: string): void {
        event.stopPropagation();
        this.drag = { kind: "node", nodeId, x: event.clientX, y: event.clientY, moved: false };
        this.svg.setPointerCapture(event.pointerId);
    }

    private movePointer(event: PointerEvent): void {
        if (!this.drag) return;
        if (this.drag.kind === "pan") {
            const dx = event.clientX - this.drag.x;
            const dy = event.clientY - this.drag.y;
            this.drag.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
            const rect = this.svg.getBoundingClientRect();
            this.transform = {
                ...this.transform,
                x: this.drag.transform.x + dx * (WIDTH / Math.max(1, rect.width)),
                y: this.drag.transform.y + dy * (HEIGHT / Math.max(1, rect.height)),
            };
            this.applyTransform();
            return;
        }
        const point = this.toWorldPoint(event);
        const position = this.positions.get(this.drag.nodeId);
        if (!position) return;
        this.drag.moved ||= Math.abs(event.clientX - this.drag.x) + Math.abs(event.clientY - this.drag.y) > 3;
        if (!this.drag.moved) return;
        position.x = clamp(point.x, NODE_RADIUS + 10, WIDTH - NODE_RADIUS - 10);
        position.y = clamp(point.y, NODE_RADIUS + 18, HEIGHT - NODE_RADIUS - 18);
        position.vx = 0;
        position.vy = 0;
        this.updateNode(this.drag.nodeId);
        this.updateConnectedEdges(this.drag.nodeId);
    }

    private endPointer(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag) return;
        this.drag = null;
        if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
        if (drag.kind === "node" && !drag.moved) this.options.onSelectNode(drag.nodeId);
    }

    private zoom(event: WheelEvent): void {
        event.preventDefault();
        const rect = this.svg.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (WIDTH / Math.max(1, rect.width));
        const y = (event.clientY - rect.top) * (HEIGHT / Math.max(1, rect.height));
        const previous = this.transform.scale;
        const next = clamp(previous * (event.deltaY < 0 ? 1.12 : 0.88), 0.4, 3);
        const worldX = (x - this.transform.x) / previous;
        const worldY = (y - this.transform.y) / previous;
        this.transform = { scale: next, x: x - worldX * next, y: y - worldY * next };
        this.applyTransform();
    }

    private updateEmphasis(): void {
        const activeNodeId = this.selectedNodeId ?? this.hoveredNodeId;
        const neighbours = new Set<string>();
        if (activeNodeId) {
            for (const edge of this.options.edges) {
                if (edge.sourceNodeId === activeNodeId) neighbours.add(edge.targetNodeId);
                if (edge.targetNodeId === activeNodeId) neighbours.add(edge.sourceNodeId);
            }
        }
        for (const [id, node] of this.nodeEls) {
            node.classList.toggle("is-selected", id === this.selectedNodeId);
            node.classList.toggle("is-hovered", id === this.hoveredNodeId);
            node.classList.toggle("is-neighbour", neighbours.has(id));
            node.classList.toggle("is-connected", this.isConnected(id));
            node.classList.toggle("is-muted", activeNodeId !== null && id !== activeNodeId && !neighbours.has(id));
        }
        for (const [id, edge] of this.edgeEls) {
            const graphEdge = this.options.edges.find((item) => item.id === id);
            const adjacent = graphEdge !== undefined && activeNodeId !== null
                && (graphEdge.sourceNodeId === activeNodeId || graphEdge.targetNodeId === activeNodeId);
            edge.classList.toggle("is-selected", id === this.selectedEdgeId);
            edge.classList.toggle("is-adjacent", adjacent);
            edge.classList.toggle("is-muted", activeNodeId !== null && !adjacent && id !== this.selectedEdgeId);
        }
    }

    private isConnected(nodeId: string): boolean {
        return this.options.edges.some((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId);
    }

    private updateNode(nodeId: string): void {
        const position = this.positions.get(nodeId);
        const element = this.nodeEls.get(nodeId);
        if (position && element) element.setAttribute("transform", `translate(${position.x} ${position.y})`);
    }

    private updateConnectedEdges(nodeId: string): void {
        for (const edge of this.options.edges) {
            if (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId) this.updateEdge(edge);
        }
    }

    private updateEdge(edge: LearningGraphEdge): void {
        const source = this.positions.get(edge.sourceNodeId);
        const target = this.positions.get(edge.targetNodeId);
        const element = this.edgeEls.get(edge.id);
        if (!source || !target || !element) return;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const sourceOffset = NODE_RADIUS + 2;
        const targetOffset = NODE_RADIUS + (edge.directed ? 8 : 2);
        element.setAttribute("x1", String(source.x + (dx / distance) * sourceOffset));
        element.setAttribute("y1", String(source.y + (dy / distance) * sourceOffset));
        element.setAttribute("x2", String(target.x - (dx / distance) * targetOffset));
        element.setAttribute("y2", String(target.y - (dy / distance) * targetOffset));
    }

    private applyTransform(): void {
        this.viewport.setAttribute("transform", `translate(${this.transform.x} ${this.transform.y}) scale(${this.transform.scale})`);
    }

    private toWorldPoint(event: PointerEvent): { x: number; y: number } {
        const rect = this.svg.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (WIDTH / Math.max(1, rect.width));
        const y = (event.clientY - rect.top) * (HEIGHT / Math.max(1, rect.height));
        return { x: (x - this.transform.x) / this.transform.scale, y: (y - this.transform.y) / this.transform.scale };
    }
}

/** Pure deterministic force layout for the capped Learning Map projection. */
export function createLearningGraphForceLayout(
    nodes: readonly LearningGraphNode[],
    edges: readonly Pick<LearningGraphEdge, "sourceNodeId" | "targetNodeId">[],
): Map<string, Point> {
    const positions = new Map<string, Point>(nodes.map((node) => {
        const seed = hash(node.id);
        return [node.id, {
            x: 48 + (seed % (WIDTH - 96)),
            y: 48 + (Math.floor(seed / 997) % (HEIGHT - 96)),
            vx: 0,
            vy: 0,
        }];
    }));
    const visibleEdges = edges.filter((edge) => positions.has(edge.sourceNodeId) && positions.has(edge.targetNodeId));
    for (let iteration = 0; iteration < 150; iteration += 1) {
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
                const squared = Math.max(36, dx * dx + dy * dy);
                const distance = Math.sqrt(squared);
                const collision = distance < MIN_NODE_DISTANCE ? (MIN_NODE_DISTANCE - distance) * 0.22 : 0;
                const force = 6500 / squared + collision;
                const forceX = (dx / distance) * force;
                const forceY = (dy / distance) * force;
                left.vx += forceX;
                left.vy += forceY;
                right.vx -= forceX;
                right.vy -= forceY;
            }
        }
        for (const edge of visibleEdges) {
            const source = positions.get(edge.sourceNodeId);
            const target = positions.get(edge.targetNodeId);
            if (!source || !target) continue;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            const force = (distance - 112) * 0.017;
            const forceX = (dx / distance) * force;
            const forceY = (dy / distance) * force;
            source.vx += forceX;
            source.vy += forceY;
            target.vx -= forceX;
            target.vy -= forceY;
        }
        for (const point of positions.values()) {
            point.vx += (WIDTH / 2 - point.x) * 0.0012;
            point.vy += (HEIGHT / 2 - point.y) * 0.0012;
            point.vx *= 0.82;
            point.vy *= 0.82;
            point.x = clamp(point.x + point.vx, NODE_RADIUS + 10, WIDTH - NODE_RADIUS - 10);
            point.y = clamp(point.y + point.vy, NODE_RADIUS + 18, HEIGHT - NODE_RADIUS - 18);
        }
    }
    return positions;
}

function createSvg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
    return document.createElementNS(SVG_NAMESPACE, tag);
}

function truncate(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function hash(value: string): number {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
    }
    return result >>> 0;
}
