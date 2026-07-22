import type { LearningGraphEdge, LearningGraphNode } from "../../domain/learning-graph/learning-graph-types";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const WIDTH = 920;
const HEIGHT = 640;
const NODE_RADIUS = 11;
let instanceSequence = 0;

export interface LearningGraphRendererOptions {
    nodes: readonly LearningGraphNode[];
    edges: readonly LearningGraphEdge[];
    selectedNodeId: string | null;
    selectedEdgeId: string | null;
    onSelectNode(nodeId: string): void;
    onSelectEdge(edgeId: string): void;
}

interface Point { x: number; y: number; }
interface Transform extends Point { scale: number; }
interface DragState { x: number; y: number; transform: Transform; moved: boolean; }

/**
 * Dependency-free SVG adapter for a capped projection. Its deterministic grid
 * is O(n + e), unlike an unbounded force simulation, and it owns only DOM.
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

    constructor(private readonly root: HTMLElement, private readonly options: LearningGraphRendererOptions) {
        this.positions = createGridPositions(options.nodes);
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
        this.transform = { x: 0, y: 0, scale: 1 };
        this.applyTransform();
    }

    setSelection(nodeId: string | null, edgeId: string | null): void {
        for (const [id, node] of this.nodeEls) node.classList.toggle("is-selected", id === nodeId);
        for (const [id, edge] of this.edgeEls) edge.classList.toggle("is-selected", id === edgeId);
    }

    destroy(): void {
        this.drag = null;
        this.nodeEls.clear();
        this.edgeEls.clear();
        this.root.empty();
    }

    private render(): void {
        // Obsidian decorates HTMLElement with isShown(), but not SVGElement.
        // Its tooltip delegation treats aria-label as a tooltip target and can
        // call isShown() on an SVG <g>/<line>, causing a core-side exception.
        // Native SVG <title> retains the accessible name without entering that
        // HTMLElement-only tooltip path.
        const title = createSvg("title");
        title.textContent = "Interactive bounded learning graph";
        this.svg.appendChild(title);
        const defs = createSvg("defs");
        const marker = createSvg("marker");
        marker.setAttribute("id", this.directedMarkerId);
        marker.setAttribute("viewBox", "0 -5 10 10");
        marker.setAttribute("refX", "18");
        marker.setAttribute("refY", "0");
        marker.setAttribute("markerWidth", "6");
        marker.setAttribute("markerHeight", "6");
        marker.setAttribute("orient", "auto");
        const path = createSvg("path");
        path.setAttribute("d", "M0,-5L10,0L0,5Z");
        path.setAttribute("class", "vault-coach-learning-map-arrow");
        marker.appendChild(path);
        defs.appendChild(marker);
        this.svg.appendChild(defs);
        const background = createSvg("rect");
        background.setAttribute("class", "vault-coach-learning-map-background");
        background.setAttribute("width", String(WIDTH));
        background.setAttribute("height", String(HEIGHT));
        this.svg.appendChild(background);
        this.svg.appendChild(this.viewport);
        this.applyTransform();
        for (const edge of this.options.edges) this.drawEdge(edge);
        for (const node of this.options.nodes) this.drawNode(node);
        background.addEventListener("pointerdown", (event) => this.beginPan(event));
        this.svg.addEventListener("pointermove", (event) => this.movePan(event));
        this.svg.addEventListener("pointerup", (event) => this.endPan(event));
        this.svg.addEventListener("pointercancel", (event) => this.endPan(event));
        this.svg.addEventListener("wheel", (event) => this.zoom(event), { passive: false });
    }

    private drawEdge(edge: LearningGraphEdge): void {
        const source = this.positions.get(edge.sourceNodeId);
        const target = this.positions.get(edge.targetNodeId);
        if (!source || !target) return;
        const line = createSvg("line");
        line.setAttribute("x1", String(source.x));
        line.setAttribute("y1", String(source.y));
        line.setAttribute("x2", String(target.x));
        line.setAttribute("y2", String(target.y));
        line.setAttribute("class", `vault-coach-learning-map-edge is-${edge.origin}${edge.id === this.options.selectedEdgeId ? " is-selected" : ""}`);
        if (edge.directed) line.setAttribute("marker-end", `url(#${this.directedMarkerId})`);
        line.setAttribute("tabindex", "0");
        const title = createSvg("title");
        title.textContent = `${edge.sourceNodeId} ${edge.type} ${edge.targetNodeId}`;
        line.appendChild(title);
        line.addEventListener("click", (event) => { event.stopPropagation(); this.options.onSelectEdge(edge.id); });
        line.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.options.onSelectEdge(edge.id); }
        });
        this.viewport.appendChild(line);
        this.edgeEls.set(edge.id, line);
    }

    private drawNode(node: LearningGraphNode): void {
        const position = this.positions.get(node.id);
        if (!position) return;
        const group = createSvg("g");
        group.setAttribute("class", `vault-coach-learning-map-node is-${node.kind}${node.id === this.options.selectedNodeId ? " is-selected" : ""}`);
        group.setAttribute("transform", `translate(${position.x} ${position.y})`);
        group.setAttribute("tabindex", "0");
        const circle = createSvg("circle");
        circle.setAttribute("r", String(NODE_RADIUS));
        const title = createSvg("title");
        title.textContent = node.label;
        group.appendChild(circle);
        if (this.options.nodes.length <= 80) {
            const label = createSvg("text");
            label.setAttribute("y", "-16");
            label.setAttribute("text-anchor", "middle");
            label.textContent = truncate(node.label, 16);
            group.appendChild(label);
        }
        group.appendChild(title);
        const select = (event?: Event) => { event?.stopPropagation(); this.options.onSelectNode(node.id); };
        group.addEventListener("click", select);
        group.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(event); }
        });
        this.viewport.appendChild(group);
        this.nodeEls.set(node.id, group);
    }

    private beginPan(event: PointerEvent): void {
        this.drag = { x: event.clientX, y: event.clientY, transform: { ...this.transform }, moved: false };
        this.svg.setPointerCapture(event.pointerId);
    }

    private movePan(event: PointerEvent): void {
        if (!this.drag) return;
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
    }

    private endPan(event: PointerEvent): void {
        if (!this.drag) return;
        this.drag = null;
        if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
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

    private applyTransform(): void {
        this.viewport.setAttribute("transform", `translate(${this.transform.x} ${this.transform.y}) scale(${this.transform.scale})`);
    }
}

function createGridPositions(nodes: readonly LearningGraphNode[]): Map<string, Point> {
    const positions = new Map<string, Point>();
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * (WIDTH / HEIGHT))));
    const rows = Math.max(1, Math.ceil(nodes.length / columns));
    const xGap = WIDTH / (columns + 1);
    const yGap = HEIGHT / (rows + 1);
    nodes.forEach((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        positions.set(node.id, { x: (column + 1) * xGap + (row % 2) * Math.min(18, xGap / 4), y: (row + 1) * yGap });
    });
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
