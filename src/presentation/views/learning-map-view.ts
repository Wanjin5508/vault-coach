import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { VaultCoachApplicationApi } from "../../app/application-api";
import { VIEW_TYPE_LEARNING_MAP } from "../../constants";
import type { LearningGraphEdge, LearningGraphEvidence, LearningGraphNode, LearningGraphProjection } from "../../domain/learning-graph/learning-graph-types";
import type { SemanticRelationType } from "../../domain/semantic-graph/semantic-graph-types";
import { LearningGraphRenderer } from "../components/learning-graph-renderer";
import { LearningMapController } from "../controllers/learning-map-controller";

export type LearningMapSourceOpener = (filePath: string, heading?: string) => Promise<void>;

const RELATION_TYPES: readonly SemanticRelationType[] = [
    "same_as", "part_of", "prerequisite_of", "used_for", "contrasts_with", "related_to",
];

/** Main-workspace explorer for confirmed learning facts; it does not edit M3 decisions. */
export class LearningMapView extends ItemView {
    private readonly controller: LearningMapController;
    private projection: LearningGraphProjection | null = null;
    private renderer: LearningGraphRenderer | null = null;
    private inspectorEl: HTMLElement | null = null;
    private selectedNodeId: string | null = null;
    private selectedEdgeId: string | null = null;
    private disposed = false;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly application: VaultCoachApplicationApi,
        private readonly openSource: LearningMapSourceOpener,
    ) {
        super(leaf);
        this.controller = new LearningMapController(application.learningGraph);
    }

    getViewType(): string { return VIEW_TYPE_LEARNING_MAP; }
    getDisplayText(): string { return "Learning map"; }
    getIcon(): string { return "waypoints"; }

    async onOpen(): Promise<void> { await this.refresh(); }

    async onClose(): Promise<void> {
        this.disposed = true;
        this.renderer?.destroy();
        this.renderer = null;
        this.inspectorEl = null;
        this.contentEl.empty();
    }

    async refresh(): Promise<void> {
        if (this.disposed) return;
        try {
            this.projection = await this.controller.getProjection();
            if (!this.disposed) this.render();
        } catch (error: unknown) {
            this.contentEl.empty();
            this.contentEl.createDiv({ cls: "vault-coach-learning-map-error", text: describeError(error) });
        }
    }

    private render(): void {
        this.renderer?.destroy();
        this.renderer = null;
        this.inspectorEl = null;
        this.contentEl.empty();
        this.contentEl.addClass("vault-coach-learning-map");
        const projection = this.projection;
        if (!projection) return;
        const header = this.contentEl.createDiv({ cls: "vault-coach-learning-map-header" });
        header.createEl("h2", { text: "Learning map" });
        header.createDiv({
            cls: "vault-coach-learning-map-summary",
            text: `${projection.stats.visibleNodeCount} nodes · ${projection.stats.visibleEdgeCount} relationships · confirmed facts only`,
        });
        const capacity = this.application.semanticGraph.getState().capacity;
        if (capacity.level !== "local") {
            header.createDiv({
                cls: "vault-coach-learning-map-capacity",
                text: capacity.level === "warning"
                    ? "Local semantic auto-sync is paused for this vault size. Manual rebuild remains available."
                    : "New local semantic rebuilds are paused for this vault size. Existing confirmed facts remain available.",
            });
        }
        this.renderToolbar(this.contentEl);
        if (!projection.sourceReady || projection.nodes.length === 0) {
            this.contentEl.createDiv({ cls: "vault-coach-learning-map-empty", text: projection.message ?? "No learning graph facts are available." });
            return;
        }
        this.retainSelection(projection);
        if (projection.stats.truncated) {
            this.contentEl.createDiv({
                cls: "vault-coach-learning-map-budget",
                text: `Local projection budget applied: ${projection.stats.hiddenNodeCount} nodes and ${projection.stats.hiddenEdgeCount} relationships are hidden. Search or focus a node to explore another bounded neighbourhood.`,
            });
        }
        const body = this.contentEl.createDiv({ cls: "vault-coach-learning-map-body" });
        const graph = body.createDiv({ cls: "vault-coach-learning-map-graph" });
        this.renderer = new LearningGraphRenderer(graph, {
            nodes: projection.nodes,
            edges: projection.edges,
            selectedNodeId: this.selectedNodeId,
            selectedEdgeId: this.selectedEdgeId,
            onSelectNode: (nodeId) => {
                this.selectedNodeId = nodeId;
                this.selectedEdgeId = null;
                this.renderer?.setSelection(nodeId, null);
                this.refreshInspector();
            },
            onSelectEdge: (edgeId) => {
                this.selectedNodeId = null;
                this.selectedEdgeId = edgeId;
                this.renderer?.setSelection(null, edgeId);
                this.refreshInspector();
            },
        });
        graph.createDiv({ cls: "vault-coach-learning-map-legend", text: "Drag empty space to pan; scroll to zoom. Arrows show relationship direction. This view only shows confirmed and user-created relationships." });
        this.inspectorEl = body.createDiv({ cls: "vault-coach-learning-map-inspector" });
        this.renderInspectorContent(this.inspectorEl, projection);
    }

    private renderToolbar(root: HTMLElement): void {
        const toolbar = root.createDiv({ cls: "vault-coach-learning-map-toolbar" });
        const search = toolbar.createEl("input", { attr: { type: "search", placeholder: "Search confirmed concepts" } });
        search.value = this.controller.getSearch();
        search.addEventListener("change", () => { this.controller.setSearch(search.value); void this.refresh(); });
        const structureLabel = toolbar.createEl("label", { cls: "vault-coach-learning-map-toggle" });
        const structure = structureLabel.createEl("input", { attr: { type: "checkbox" } });
        structure.checked = this.controller.hasStructuralContext();
        structureLabel.createSpan({ text: "Show source structure" });
        structure.addEventListener("change", () => { this.controller.setStructuralContext(structure.checked); void this.refresh(); });
        const fit = toolbar.createEl("button", { text: "Fit graph" });
        fit.addEventListener("click", () => this.renderer?.fit());
        const reset = toolbar.createEl("button", { text: "Reset exploration" });
        reset.addEventListener("click", () => {
            this.controller.reset();
            this.selectedNodeId = null;
            this.selectedEdgeId = null;
            void this.refresh();
        });
        const filter = root.createDiv({ cls: "vault-coach-learning-map-filter" });
        filter.createSpan({ text: "Relationship types:" });
        const selected = new Set(this.controller.getRelationTypes());
        for (const type of RELATION_TYPES) {
            const label = filter.createEl("label", { cls: "vault-coach-learning-map-toggle" });
            const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
            checkbox.checked = selected.size === 0 || selected.has(type);
            label.createSpan({ text: type });
            checkbox.addEventListener("change", () => {
                const next = new Set(this.controller.getRelationTypes());
                if (next.size === 0) RELATION_TYPES.forEach((item) => next.add(item));
                if (checkbox.checked) next.add(type);
                else next.delete(type);
                this.controller.setRelationTypes(Array.from(next));
                void this.refresh();
            });
        }
    }

    private refreshInspector(): void {
        if (!this.inspectorEl || !this.projection) return;
        this.inspectorEl.empty();
        this.renderInspectorContent(this.inspectorEl, this.projection);
    }

    private renderInspectorContent(inspector: HTMLElement, projection: LearningGraphProjection): void {
        const node = projection.nodes.find((item) => item.id === this.selectedNodeId);
        if (node) {
            this.renderNodeInspector(inspector, node, projection);
            return;
        }
        const edge = projection.edges.find((item) => item.id === this.selectedEdgeId);
        if (edge) {
            this.renderEdgeInspector(inspector, edge, projection);
            return;
        }
        inspector.createEl("h3", { text: "Inspector" });
        inspector.createDiv({ text: "Select a confirmed concept or relationship to inspect its direction and source evidence." });
    }

    private renderNodeInspector(inspector: HTMLElement, node: LearningGraphNode, projection: LearningGraphProjection): void {
        inspector.createEl("h3", { text: node.label });
        inspector.createDiv({ cls: "vault-coach-learning-map-muted", text: `${node.kind} · ${node.id}` });
        if (node.description) inspector.createDiv({ text: node.description });
        if (node.aliases.length > 0) inspector.createDiv({ cls: "vault-coach-learning-map-muted", text: `Aliases: ${node.aliases.join(", ")}` });
        const outgoing = projection.edges.filter((edge) => edge.sourceNodeId === node.id);
        const incoming = projection.edges.filter((edge) => edge.targetNodeId === node.id);
        inspector.createDiv({ cls: "vault-coach-learning-map-muted", text: `${outgoing.length} outgoing · ${incoming.length} incoming relationship(s) in this local projection` });
        const actions = inspector.createDiv({ cls: "vault-coach-learning-map-actions" });
        const focus = actions.createEl("button", { text: "Focus neighbourhood", cls: "mod-cta" });
        focus.addEventListener("click", () => { this.controller.setFocus(node.id); this.selectedEdgeId = null; void this.refresh(); });
        this.renderEvidence(inspector, node.evidence);
    }

    private renderEdgeInspector(inspector: HTMLElement, edge: LearningGraphEdge, projection: LearningGraphProjection): void {
        const source = projection.nodes.find((node) => node.id === edge.sourceNodeId)?.label ?? edge.sourceNodeId;
        const target = projection.nodes.find((node) => node.id === edge.targetNodeId)?.label ?? edge.targetNodeId;
        inspector.createEl("h3", { text: edge.type });
        inspector.createDiv({ text: `${source} ${edge.directed ? "→" : "—"} ${target}` });
        inspector.createDiv({ cls: "vault-coach-learning-map-muted", text: `${edge.origin} · ${Math.round(edge.confidence * 100)}% confidence` });
        this.renderEvidence(inspector, edge.evidence);
    }

    private renderEvidence(container: HTMLElement, evidence: readonly LearningGraphEvidence[]): void {
        container.createEl("h4", { text: "Evidence" });
        if (evidence.length === 0) {
            container.createDiv({ cls: "vault-coach-learning-map-muted", text: "No additional source location is stored for this structural node." });
            return;
        }
        const list = container.createDiv({ cls: "vault-coach-learning-map-evidence" });
        for (const item of evidence) {
            if (item.kind === "user-decision") {
                list.createDiv({ text: `User decision: ${item.decisionId}` });
                continue;
            }
            const filePath = item.kind === "concept-evidence"
                ? item.locator.type === "zotero" ? "" : item.locator.filePath
                : item.source.sourceFilePath;
            const heading = item.kind === "concept-evidence" && item.locator.type === "markdown" ? item.locator.heading : undefined;
            const summary = item.kind === "concept-evidence"
                ? `${filePath}${heading ? ` › ${heading}` : ""}: ${item.textPreview}`
                : `${filePath} · ${item.source.sourceKind}`;
            const row = list.createDiv({ cls: "vault-coach-learning-map-evidence-row" });
            row.createDiv({ text: summary });
            if (filePath) {
                const open = row.createEl("button", { text: "Open source" });
                open.addEventListener("click", () => void this.openEvidence(filePath, heading));
            }
        }
    }

    private async openEvidence(filePath: string, heading?: string): Promise<void> {
        try {
            await this.openSource(filePath, heading);
        } catch (error: unknown) {
            new Notice(describeError(error));
        }
    }

    private retainSelection(projection: LearningGraphProjection): void {
        if (this.selectedNodeId && !projection.nodes.some((node) => node.id === this.selectedNodeId)) this.selectedNodeId = null;
        if (this.selectedEdgeId && !projection.edges.some((edge) => edge.id === this.selectedEdgeId)) this.selectedEdgeId = null;
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
