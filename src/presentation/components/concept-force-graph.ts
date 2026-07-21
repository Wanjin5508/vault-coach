import type {
    EffectiveSemanticRelation,
    SemanticCandidate,
    SemanticConcept,
} from "../../domain/semantic-graph/semantic-graph-types";
import { isUndirectedRelation } from "../../domain/semantic-graph/concept-candidate-fingerprint";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
// This compact, near-vertical viewBox is deliberate: with an inspector beside
// the graph, a 720px-wide coordinate system would scale labels down too far.
// It resembles Obsidian's local graph while keeping names readable in a leaf.
const WIDTH = 560;
const HEIGHT = 760;
const NODE_RADIUS = 13;
const MIN_NODE_DISTANCE = 82;
let graphInstanceSequence = 0;

export interface ConceptForceGraphOptions {
    concepts: readonly SemanticConcept[];
    relations: readonly EffectiveSemanticRelation[];
    candidates: readonly SemanticCandidate[];
    selectedConceptIds: ReadonlySet<string>;
    onSelectConcept(conceptId: string, multiSelect: boolean): void;
    onSelectCandidate(fingerprint: string): void;
    onSelectRelation(relationId: string): void;
}

interface GraphNodePosition {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
}

interface GraphEdge {
    sourceConceptId: string;
    targetConceptId: string;
    pending: boolean;
    directed: boolean;
    label: string;
    fingerprint?: string;
    relationId?: string;
}

interface GraphTransform {
    x: number;
    y: number;
    scale: number;
}

interface DragState {
    kind: "pan" | "node";
    startClientX: number;
    startClientY: number;
    startTransform: GraphTransform;
    conceptId?: string;
    multiSelect?: boolean;
    moved: boolean;
}

interface RenderedNode {
    group: SVGGElement;
    circle: SVGCircleElement;
    label: SVGTextElement;
}

interface RenderedEdge {
    line: SVGLineElement;
    edge: GraphEdge;
}

/**
 * A deliberately small, dependency-free force graph for a local review
 * projection. It never receives the entire Vault graph: at most a few dozen
 * nodes are laid out, so its O(n²) visual repulsion is bounded and unrelated
 * to semantic ANN work.
 */
export class ConceptForceGraph {
    private readonly svg: SVGSVGElement;
    private readonly viewport: SVGGElement;
    private readonly positions: Map<string, GraphNodePosition>;
    private readonly renderedNodes = new Map<string, RenderedNode>();
    private readonly renderedEdges: RenderedEdge[] = [];
    private readonly confirmedMarkerId: string;
    private readonly pendingMarkerId: string;
    private transform: GraphTransform = { x: 0, y: 0, scale: 1 };
    private dragState: DragState | null = null;

    constructor(private readonly root: HTMLElement, private readonly options: ConceptForceGraphOptions) {
        const instanceId = ++graphInstanceSequence;
        this.confirmedMarkerId = `vault-coach-concept-arrow-confirmed-${instanceId}`;
        this.pendingMarkerId = `vault-coach-concept-arrow-pending-${instanceId}`;
        this.positions = createForceLayout(options.concepts, collectEdges(options));
        this.svg = createSvgElement("svg");
        this.svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
        this.svg.setAttribute("role", "img");
        this.svg.setAttribute("aria-label", "Interactive local concept relationship graph");
        this.svg.classList.add("vault-coach-concept-force-graph");
        this.viewport = createSvgElement("g");
        this.root.appendChild(this.svg);
        this.render();
    }

    fit(): void {
        this.transform = { x: 0, y: 0, scale: 1 };
        this.applyTransform();
    }

    setSelectedConceptIds(selectedConceptIds: ReadonlySet<string>): void {
        for (const [conceptId, rendered] of this.renderedNodes) {
            rendered.group.classList.toggle("is-selected", selectedConceptIds.has(conceptId));
        }
    }

    destroy(): void {
        this.dragState = null;
        this.renderedNodes.clear();
        this.renderedEdges.length = 0;
        this.root.empty();
    }

    private render(): void {
        this.renderArrowMarkers();
        const background = createSvgElement("rect");
        background.setAttribute("x", "0");
        background.setAttribute("y", "0");
        background.setAttribute("width", String(WIDTH));
        background.setAttribute("height", String(HEIGHT));
        background.setAttribute("class", "vault-coach-concept-graph-background");
        this.svg.appendChild(background);
        this.svg.appendChild(this.viewport);
        this.applyTransform();

        for (const edge of collectEdges(this.options)) this.drawEdge(edge);
        for (const concept of this.options.concepts) this.drawNode(concept);
        this.bindPointerInteractions(background);
    }

    private drawEdge(edge: GraphEdge): void {
        const source = this.positions.get(edge.sourceConceptId);
        const target = this.positions.get(edge.targetConceptId);
        if (!source || !target) return;
        const line = createSvgElement("line");
        line.setAttribute("class", edge.pending ? "vault-coach-concept-edge is-pending" : "vault-coach-concept-edge is-confirmed");
        line.setAttribute("aria-label", edge.label);
        line.setAttribute("data-tooltip-position", "top");
        if (edge.directed) {
            line.setAttribute("marker-end", `url(#${edge.pending ? this.pendingMarkerId : this.confirmedMarkerId})`);
        }
        if (edge.pending && edge.fingerprint) {
            line.setAttribute("tabindex", "0");
            line.addEventListener("click", (event) => {
                event.stopPropagation();
                this.options.onSelectCandidate(edge.fingerprint ?? "");
            });
        } else if (edge.relationId) {
            line.setAttribute("tabindex", "0");
            line.addEventListener("click", (event) => {
                event.stopPropagation();
                this.options.onSelectRelation(edge.relationId ?? "");
            });
        }
        this.viewport.appendChild(line);
        this.renderedEdges.push({ line, edge });
        this.updateEdge({ line, edge });
    }

    private drawNode(concept: SemanticConcept): void {
        const position = this.positions.get(concept.id);
        if (!position) return;
        const group = createSvgElement("g");
        group.setAttribute("class", this.options.selectedConceptIds.has(concept.id) ? "vault-coach-concept-node is-selected" : "vault-coach-concept-node");
        group.setAttribute("tabindex", "0");
        group.setAttribute("aria-label", concept.displayName);
        const circle = createSvgElement("circle");
        circle.setAttribute("r", String(NODE_RADIUS));
        const label = createSvgElement("text");
        label.setAttribute("text-anchor", "middle");
        // Alternating labels above/below the node reduces collisions in a
        // dense local cluster without hiding a concept's name entirely.
        label.setAttribute("y", String(position.y < HEIGHT / 2 ? -20 : 28));
        label.textContent = truncate(concept.displayName, 14);
        const title = createSvgElement("title");
        title.textContent = concept.displayName;
        group.appendChild(circle);
        group.appendChild(label);
        group.appendChild(title);
        this.viewport.appendChild(group);
        this.renderedNodes.set(concept.id, { group, circle, label });
        this.updateNode(concept.id);
        group.addEventListener("pointerdown", (event) => this.beginNodeDrag(event, concept.id));
        group.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                this.options.onSelectConcept(concept.id, event.ctrlKey || event.metaKey);
            }
        });
    }

    private bindPointerInteractions(background: SVGRectElement): void {
        background.addEventListener("pointerdown", (event) => this.beginPan(event));
        this.svg.addEventListener("pointermove", (event) => this.handlePointerMove(event));
        this.svg.addEventListener("pointerup", (event) => this.finishPointer(event));
        this.svg.addEventListener("pointercancel", (event) => this.finishPointer(event));
        this.svg.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    }

    private beginPan(event: PointerEvent): void {
        this.dragState = {
            kind: "pan",
            startClientX: event.clientX,
            startClientY: event.clientY,
            startTransform: { ...this.transform },
            moved: false,
        };
        this.svg.setPointerCapture(event.pointerId);
    }

    private beginNodeDrag(event: PointerEvent, conceptId: string): void {
        event.stopPropagation();
        this.dragState = {
            kind: "node",
            startClientX: event.clientX,
            startClientY: event.clientY,
            startTransform: { ...this.transform },
            conceptId,
            multiSelect: event.ctrlKey || event.metaKey,
            moved: false,
        };
        this.svg.setPointerCapture(event.pointerId);
    }

    private handlePointerMove(event: PointerEvent): void {
        const drag = this.dragState;
        if (!drag) return;
        const moved = Math.abs(event.clientX - drag.startClientX) + Math.abs(event.clientY - drag.startClientY) > 3;
        drag.moved ||= moved;
        if (drag.kind === "pan") {
            const scale = this.svgScale();
            this.transform = {
                ...this.transform,
                x: drag.startTransform.x + (event.clientX - drag.startClientX) * scale.x,
                y: drag.startTransform.y + (event.clientY - drag.startClientY) * scale.y,
            };
            this.applyTransform();
            return;
        }
        const conceptId = drag.conceptId;
        const position = conceptId ? this.positions.get(conceptId) : undefined;
        if (!conceptId || !position) return;
        const point = this.toWorldPoint(event);
        position.x = clamp(point.x, NODE_RADIUS + 12, WIDTH - NODE_RADIUS - 12);
        position.y = clamp(point.y, NODE_RADIUS + 18, HEIGHT - NODE_RADIUS - 36);
        position.vx = 0;
        position.vy = 0;
        this.updateNode(conceptId);
        this.updateConnectedEdges(conceptId);
    }

    private finishPointer(event: PointerEvent): void {
        const drag = this.dragState;
        if (!drag) return;
        this.dragState = null;
        if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
        if (drag.kind === "node" && !drag.moved && drag.conceptId) {
            this.options.onSelectConcept(drag.conceptId, drag.multiSelect ?? false);
        }
    }

    private handleWheel(event: WheelEvent): void {
        event.preventDefault();
        const rect = this.svg.getBoundingClientRect();
        const viewX = (event.clientX - rect.left) * (WIDTH / Math.max(1, rect.width));
        const viewY = (event.clientY - rect.top) * (HEIGHT / Math.max(1, rect.height));
        const previousScale = this.transform.scale;
        const nextScale = clamp(previousScale * (event.deltaY < 0 ? 1.12 : 0.88), 0.45, 3);
        const worldX = (viewX - this.transform.x) / previousScale;
        const worldY = (viewY - this.transform.y) / previousScale;
        this.transform = {
            x: viewX - worldX * nextScale,
            y: viewY - worldY * nextScale,
            scale: nextScale,
        };
        this.applyTransform();
    }

    private updateNode(conceptId: string): void {
        const position = this.positions.get(conceptId);
        const rendered = this.renderedNodes.get(conceptId);
        if (!position || !rendered) return;
        rendered.group.setAttribute("transform", `translate(${position.x} ${position.y})`);
    }

    private updateConnectedEdges(conceptId: string): void {
        for (const rendered of this.renderedEdges) {
            if (rendered.edge.sourceConceptId === conceptId || rendered.edge.targetConceptId === conceptId) {
                this.updateEdge(rendered);
            }
        }
    }

    private updateEdge(rendered: RenderedEdge): void {
        const source = this.positions.get(rendered.edge.sourceConceptId);
        const target = this.positions.get(rendered.edge.targetConceptId);
        if (!source || !target) return;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const sourceOffset = NODE_RADIUS + 2;
        const targetOffset = NODE_RADIUS + (rendered.edge.directed ? 9 : 2);
        rendered.line.setAttribute("x1", String(source.x + (dx / distance) * sourceOffset));
        rendered.line.setAttribute("y1", String(source.y + (dy / distance) * sourceOffset));
        rendered.line.setAttribute("x2", String(target.x - (dx / distance) * targetOffset));
        rendered.line.setAttribute("y2", String(target.y - (dy / distance) * targetOffset));
    }

    private applyTransform(): void {
        this.viewport.setAttribute("transform", `translate(${this.transform.x} ${this.transform.y}) scale(${this.transform.scale})`);
    }

    private toWorldPoint(event: PointerEvent): { x: number; y: number } {
        const rect = this.svg.getBoundingClientRect();
        const viewX = (event.clientX - rect.left) * (WIDTH / Math.max(1, rect.width));
        const viewY = (event.clientY - rect.top) * (HEIGHT / Math.max(1, rect.height));
        return {
            x: (viewX - this.transform.x) / this.transform.scale,
            y: (viewY - this.transform.y) / this.transform.scale,
        };
    }

    private svgScale(): { x: number; y: number } {
        const rect = this.svg.getBoundingClientRect();
        return { x: WIDTH / Math.max(1, rect.width), y: HEIGHT / Math.max(1, rect.height) };
    }

    private renderArrowMarkers(): void {
        const definitions = createSvgElement("defs");
        this.appendArrowMarker(definitions, this.confirmedMarkerId, "is-confirmed");
        this.appendArrowMarker(definitions, this.pendingMarkerId, "is-pending");
        this.svg.appendChild(definitions);
    }

    private appendArrowMarker(definitions: SVGDefsElement, id: string, kind: "is-confirmed" | "is-pending"): void {
        const marker = createSvgElement("marker");
        marker.setAttribute("id", id);
        marker.setAttribute("viewBox", "0 0 8 8");
        marker.setAttribute("refX", "7");
        marker.setAttribute("refY", "4");
        marker.setAttribute("markerWidth", "5");
        marker.setAttribute("markerHeight", "5");
        marker.setAttribute("orient", "auto");
        marker.setAttribute("markerUnits", "strokeWidth");
        const path = createSvgElement("path");
        path.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
        path.setAttribute("class", `vault-coach-concept-arrow ${kind}`);
        marker.appendChild(path);
        definitions.appendChild(marker);
    }
}

/** Pure and testable local layout. At most the review-view node budget reaches this function. */
export function createForceLayout(
    concepts: readonly SemanticConcept[],
    edges: readonly Pick<GraphEdge, "sourceConceptId" | "targetConceptId">[],
): Map<string, GraphNodePosition> {
    const positions = new Map<string, GraphNodePosition>(concepts.map((concept) => {
        const seed = hash(concept.id);
        return [concept.id, {
            id: concept.id,
            x: NODE_RADIUS + 34 + (seed % (WIDTH - (NODE_RADIUS + 34) * 2)),
            y: NODE_RADIUS + 48 + (Math.floor(seed / 997) % (HEIGHT - (NODE_RADIUS + 48) * 2)),
            vx: 0,
            vy: 0,
        }];
    }));
    const visibleEdges = edges.filter((edge) => positions.has(edge.sourceConceptId) && positions.has(edge.targetConceptId));
    for (let iteration = 0; iteration < 220; iteration += 1) {
        const nodes = Array.from(positions.values());
        for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
            const left = nodes[leftIndex];
            if (!left) continue;
            for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
                const right = nodes[rightIndex];
                if (!right) continue;
                const direction = hash(`${left.id}\u0000${right.id}`) % 2 === 0 ? 1 : -1;
                const dx = left.x - right.x || direction * 0.01;
                const dy = left.y - right.y || -direction * 0.01;
                const distanceSquared = Math.max(64, dx * dx + dy * dy);
                const force = 12500 / distanceSquared;
                const distance = Math.sqrt(distanceSquared);
                const collision = distance < MIN_NODE_DISTANCE
                    ? (MIN_NODE_DISTANCE - distance) * 0.32
                    : 0;
                const forceX = (dx / distance) * (force + collision);
                const forceY = (dy / distance) * (force + collision);
                left.vx += forceX;
                left.vy += forceY;
                right.vx -= forceX;
                right.vy -= forceY;
            }
        }
        for (const edge of visibleEdges) {
            const source = positions.get(edge.sourceConceptId);
            const target = positions.get(edge.targetConceptId);
            if (!source || !target) continue;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            const force = (distance - 150) * 0.018;
            const forceX = (dx / distance) * force;
            const forceY = (dy / distance) * force;
            source.vx += forceX;
            source.vy += forceY;
            target.vx -= forceX;
            target.vy -= forceY;
        }
        for (const node of positions.values()) {
            node.vx += (WIDTH / 2 - node.x) * 0.0009;
            node.vy += (HEIGHT / 2 - node.y) * 0.0009;
            node.vx *= 0.84;
            node.vy *= 0.84;
            node.x = clamp(node.x + node.vx, NODE_RADIUS + 12, WIDTH - NODE_RADIUS - 12);
            node.y = clamp(node.y + node.vy, NODE_RADIUS + 24, HEIGHT - NODE_RADIUS - 42);
        }
    }
    return positions;
}

function collectEdges(options: Pick<ConceptForceGraphOptions, "concepts" | "relations" | "candidates">): GraphEdge[] {
    const conceptIds = new Set(options.concepts.map((concept) => concept.id));
    return [
        ...options.relations.map((relation) => ({
            sourceConceptId: relation.sourceConceptId,
            targetConceptId: relation.targetConceptId,
            pending: false,
            directed: !isUndirectedRelation(relation.type),
            label: relation.type,
            relationId: relation.id,
        })),
        ...options.candidates.map((candidate) => ({
            sourceConceptId: candidate.sourceConceptId,
            targetConceptId: candidate.targetConceptId,
            pending: true,
            directed: !isUndirectedRelation(candidate.type),
            label: `${candidate.type} (${Math.round(candidate.confidence * 100)}%)`,
            fingerprint: candidate.fingerprint,
        })),
    ].filter((edge) => conceptIds.has(edge.sourceConceptId) && conceptIds.has(edge.targetConceptId));
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(tagName: K): SVGElementTagNameMap[K] {
    return document.createElementNS(SVG_NAMESPACE, tagName);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function hash(value: string): number {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
    }
    return result >>> 0;
}

function truncate(value: string, length: number): string {
    return value.length > length ? `${value.slice(0, Math.max(1, length - 1))}…` : value;
}
