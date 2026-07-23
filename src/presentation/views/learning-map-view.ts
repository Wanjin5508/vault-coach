import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { VaultCoachApplicationApi } from "../../app/application-api";
import { VIEW_TYPE_LEARNING_MAP } from "../../constants";
import type { LearningGraphEdge, LearningGraphEvidence, LearningGraphNode, LearningGraphProjection, LearningGraphRelationType } from "../../domain/learning-graph/learning-graph-types";
import type { SemanticRelationType } from "../../domain/semantic-graph/semantic-graph-types";
import { translate, type TranslationKey } from "../../i18n";
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
    getDisplayText(): string { return this.t("learningMap.title"); }
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
        } catch {
            this.contentEl.empty();
            this.contentEl.createDiv({ cls: "vault-coach-learning-map-error", text: this.t("learningMap.unavailable") });
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
        const semanticState = this.application.semanticGraph.getState();
        const header = this.contentEl.createDiv({ cls: "vault-coach-learning-map-header" });
        header.createEl("h2", { text: this.t("learningMap.title") });
        header.createDiv({
            cls: "vault-coach-learning-map-summary",
            text: this.t("learningMap.summary", {
                nodes: projection.stats.visibleNodeCount,
                relationships: projection.stats.visibleEdgeCount,
            }),
        });
        if (semanticState.busy) this.renderSemanticBuildStatus(header, semanticState.progress);
        const capacity = semanticState.capacity;
        if (capacity.level !== "local") {
            header.createDiv({
                cls: "vault-coach-learning-map-capacity",
                text: capacity.level === "warning"
                    ? this.t("learningMap.capacityWarning")
                    : this.t("learningMap.capacityPaused"),
            });
        }
        this.renderToolbar(this.contentEl);
        if (!projection.sourceReady || projection.nodes.length === 0) {
            this.contentEl.createDiv({
                cls: "vault-coach-learning-map-empty",
                text: semanticState.busy
                    ? this.t("learningMap.emptyBuilding")
                    : projection.sourceReady ? this.t("learningMap.empty") : this.t("learningMap.unavailable"),
            });
            return;
        }
        this.retainSelection(projection);
        if (projection.stats.truncated) {
            this.contentEl.createDiv({
                cls: "vault-coach-learning-map-budget",
                text: this.t("learningMap.budget", {
                    nodes: projection.stats.hiddenNodeCount,
                    relationships: projection.stats.hiddenEdgeCount,
                }),
            });
        }
        const body = this.contentEl.createDiv({ cls: "vault-coach-learning-map-body" });
        const graph = body.createDiv({ cls: "vault-coach-learning-map-graph" });
        this.renderer = new LearningGraphRenderer(graph, {
            nodes: projection.nodes,
            edges: projection.edges,
            accessibleTitle: this.t("learningMap.a11yTitle"),
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
        graph.createDiv({ cls: "vault-coach-learning-map-legend", text: this.t("learningMap.legend") });
        this.inspectorEl = body.createDiv({ cls: "vault-coach-learning-map-inspector" });
        this.renderInspectorContent(this.inspectorEl, projection);
    }

    private renderToolbar(root: HTMLElement): void {
        const toolbar = root.createDiv({ cls: "vault-coach-learning-map-toolbar" });
        const search = toolbar.createEl("input", { attr: { type: "search", placeholder: this.t("learningMap.search") } });
        search.value = this.controller.getSearch();
        search.addEventListener("change", () => { this.controller.setSearch(search.value); void this.refresh(); });
        const structureLabel = toolbar.createEl("label", { cls: "vault-coach-learning-map-toggle" });
        const structure = structureLabel.createEl("input", { attr: { type: "checkbox" } });
        structure.checked = this.controller.hasStructuralContext();
        structureLabel.createSpan({ text: this.t("learningMap.showSource") });
        structure.addEventListener("change", () => { this.controller.setStructuralContext(structure.checked); void this.refresh(); });
        const fit = toolbar.createEl("button", { text: this.t("learningMap.fit") });
        fit.addEventListener("click", () => this.renderer?.fit());
        if (this.controller.canGoBack()) {
            const back = toolbar.createEl("button", { text: this.t("learningMap.back") });
            back.addEventListener("click", () => {
                if (!this.controller.goBack()) return;
                this.selectedNodeId = null;
                this.selectedEdgeId = null;
                void this.refresh();
            });
        }
        const reset = toolbar.createEl("button", { text: this.t("learningMap.reset") });
        reset.addEventListener("click", () => {
            this.controller.reset();
            this.selectedNodeId = null;
            this.selectedEdgeId = null;
            void this.refresh();
        });
        const filter = root.createDiv({ cls: "vault-coach-learning-map-filter" });
        filter.createSpan({ text: this.t("learningMap.relationshipTypes") });
        const selected = new Set(this.controller.getRelationTypes());
        for (const type of RELATION_TYPES) {
            const label = filter.createEl("label", { cls: "vault-coach-learning-map-toggle" });
            const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
            checkbox.checked = selected.size === 0 || selected.has(type);
            label.createSpan({ text: this.relationLabel(type) });
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
        inspector.createEl("h3", { text: this.t("learningMap.inspector") });
        inspector.createDiv({ text: this.t("learningMap.select") });
    }

    private renderNodeInspector(inspector: HTMLElement, node: LearningGraphNode, projection: LearningGraphProjection): void {
        inspector.createEl("h3", { text: node.label });
        inspector.createDiv({ cls: "vault-coach-learning-map-muted", text: `${this.nodeKindLabel(node.kind)} · ${node.id}` });
        if (node.description) inspector.createDiv({ text: node.description });
        if (node.aliases.length > 0) inspector.createDiv({ cls: "vault-coach-learning-map-muted", text: this.t("learningMap.aliases", { aliases: node.aliases.join(", ") }) });
        const outgoing = projection.edges.filter((edge) => edge.sourceNodeId === node.id);
        const incoming = projection.edges.filter((edge) => edge.targetNodeId === node.id);
        inspector.createDiv({
            cls: "vault-coach-learning-map-muted",
            text: this.t("learningMap.relationshipCount", { outgoing: outgoing.length, incoming: incoming.length }),
        });
        const actions = inspector.createDiv({ cls: "vault-coach-learning-map-actions" });
        const focus = actions.createEl("button", { text: this.t("learningMap.focus"), cls: "mod-cta" });
        focus.addEventListener("click", () => { this.controller.setFocus(node.id); this.selectedEdgeId = null; void this.refresh(); });
        this.renderEvidence(inspector, node.evidence);
    }

    private renderEdgeInspector(inspector: HTMLElement, edge: LearningGraphEdge, projection: LearningGraphProjection): void {
        const source = projection.nodes.find((node) => node.id === edge.sourceNodeId)?.label ?? edge.sourceNodeId;
        const target = projection.nodes.find((node) => node.id === edge.targetNodeId)?.label ?? edge.targetNodeId;
        inspector.createEl("h3", { text: this.relationLabel(edge.type) });
        inspector.createDiv({ text: `${source} ${edge.directed ? "→" : "—"} ${target}` });
        inspector.createDiv({
            cls: "vault-coach-learning-map-muted",
            text: this.t("learningMap.confidence", {
                origin: this.originLabel(edge.origin),
                confidence: Math.round(edge.confidence * 100),
            }),
        });
        this.renderEvidence(inspector, edge.evidence);
    }

    private renderEvidence(container: HTMLElement, evidence: readonly LearningGraphEvidence[]): void {
        container.createEl("h4", { text: this.t("learningMap.evidence") });
        if (evidence.length === 0) {
            container.createDiv({ cls: "vault-coach-learning-map-muted", text: this.t("learningMap.noEvidence") });
            return;
        }
        const list = container.createDiv({ cls: "vault-coach-learning-map-evidence" });
        for (const item of evidence) {
            if (item.kind === "user-decision") {
                list.createDiv({ text: this.t("learningMap.userDecision", { id: item.decisionId }) });
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
                const open = row.createEl("button", { text: this.t("learningMap.openSource") });
                open.addEventListener("click", () => void this.openEvidence(filePath, heading));
            }
        }
    }

    private async openEvidence(filePath: string, heading?: string): Promise<void> {
        try {
            await this.openSource(filePath, heading);
        } catch {
            new Notice(this.t("learningMap.unavailable"));
        }
    }

    private retainSelection(projection: LearningGraphProjection): void {
        if (this.selectedNodeId && !projection.nodes.some((node) => node.id === this.selectedNodeId)) this.selectedNodeId = null;
        if (this.selectedEdgeId && !projection.edges.some((edge) => edge.id === this.selectedEdgeId)) this.selectedEdgeId = null;
    }

    private renderSemanticBuildStatus(container: HTMLElement, progress: { processedSections: number; queuedSections: number }): void {
        const status = container.createDiv({
            cls: "vault-coach-semantic-build-status",
            attr: { role: "status", "aria-live": "polite" },
        });
        status.createSpan({ cls: "vault-coach-thinking-spinner", attr: { "aria-hidden": "true" } });
        const text = progress.queuedSections > 0
            ? this.t("learningMap.buildingProgress", { processed: progress.processedSections, total: progress.queuedSections })
            : this.t("learningMap.building");
        status.createSpan({ text });
    }

    private relationLabel(type: LearningGraphRelationType): string {
        if (RELATION_TYPES.includes(type as SemanticRelationType)) {
            return this.t(`semantic.relation.${type}` as TranslationKey);
        }
        return this.t(`learningMap.relation.${type}` as TranslationKey);
    }

    private nodeKindLabel(kind: LearningGraphNode["kind"]): string {
        return this.t(`learningMap.kind.${kind}` as TranslationKey);
    }

    private originLabel(origin: LearningGraphEdge["origin"]): string {
        return this.t(`learningMap.origin.${origin}` as TranslationKey);
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }
}
