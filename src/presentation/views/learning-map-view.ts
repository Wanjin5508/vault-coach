import { ItemView, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { VaultCoachApplicationApi } from "../../app/application-api";
import { VIEW_TYPE_LEARNING_MAP } from "../../constants";
import {
    LEARNING_GRAPH_MAX_EDGES,
    LEARNING_GRAPH_MAX_NODES,
    type LearningGraphEdge,
    type LearningGraphEvidence,
    type LearningGraphNode,
    type LearningGraphProjection,
    type LearningGraphRelationType,
} from "../../domain/learning-graph/learning-graph-types";
import type { SemanticGraphStateView, SemanticRelationType } from "../../domain/semantic-graph/semantic-graph-types";
import type { ConceptMasteryState } from "../../domain/mastery/mastery-types";
import { translate, type TranslationKey } from "../../i18n";
import {
    LearningGraphRenderer,
    normalizeLearningGraphPinnedPositions,
    type LearningGraphPinnedPosition,
} from "../components/learning-graph-renderer";
import { LearningMapController, type LearningMapControllerState } from "../controllers/learning-map-controller";

export type LearningMapSourceOpener = (filePath: string, heading?: string) => Promise<void>;
/** Opens the existing Exam setup with a transparent, source-file-bound scope. */
export type LearningMapExamStarter = (sourcePaths: readonly string[]) => Promise<void>;

const RELATION_TYPES: readonly SemanticRelationType[] = [
    "same_as", "part_of", "prerequisite_of", "used_for", "contrasts_with", "related_to",
];

interface EvidenceSource {
    filePath: string;
    heading?: string;
    label: string;
}

const LEARNING_MAP_LEAF_STATE_VERSION = 1 as const;

interface LearningMapLeafState {
    version: typeof LEARNING_MAP_LEAF_STATE_VERSION;
    explorer: LearningMapControllerState;
    selectedNodeId: string | null;
    selectedEdgeId: string | null;
    pinnedPositions: Record<string, LearningGraphPinnedPosition>;
}

/** Main-workspace explorer for confirmed facts and clearly marked display-only candidates. */
export class LearningMapView extends ItemView {
    private readonly controller: LearningMapController;
    private projection: LearningGraphProjection | null = null;
    private renderer: LearningGraphRenderer | null = null;
    private inspectorEl: HTMLElement | null = null;
    private selectedNodeId: string | null = null;
    private selectedEdgeId: string | null = null;
    private pinnedPositions: Record<string, LearningGraphPinnedPosition> = {};
    private refreshRevision = 0;
    private searchFocusTimer: number | null = null;
    private disposed = false;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly application: VaultCoachApplicationApi,
        private readonly openSource: LearningMapSourceOpener,
        private readonly startExamForSources?: LearningMapExamStarter,
    ) {
        super(leaf);
        this.controller = new LearningMapController(application.learningGraph);
    }

    getViewType(): string { return VIEW_TYPE_LEARNING_MAP; }
    getDisplayText(): string { return this.t("learningMap.title"); }
    getIcon(): string { return "waypoints"; }

    async onOpen(): Promise<void> {
        this.disposed = false;
        await this.refresh();
    }

    async onClose(): Promise<void> {
        this.disposed = true;
        this.refreshRevision += 1;
        this.clearSearchFocusTimer();
        this.captureRendererLayout();
        this.renderer?.destroy();
        this.renderer = null;
        this.inspectorEl = null;
        this.contentEl.empty();
        this.contentEl.removeClass("vault-coach-learning-map");
    }

    getState(): Record<string, unknown> {
        this.captureRendererLayout();
        const state: LearningMapLeafState = {
            version: LEARNING_MAP_LEAF_STATE_VERSION,
            explorer: this.controller.getViewState(),
            selectedNodeId: this.selectedNodeId,
            selectedEdgeId: this.selectedEdgeId,
            pinnedPositions: { ...this.pinnedPositions },
        };
        return {
            version: state.version,
            explorer: state.explorer,
            selectedNodeId: state.selectedNodeId,
            selectedEdgeId: state.selectedEdgeId,
            pinnedPositions: state.pinnedPositions,
        };
    }

    async setState(state: unknown, result: ViewStateResult): Promise<void> {
        await super.setState(state, result);
        if (!isLearningMapLeafState(state)) return;
        this.controller.restoreViewState(state.explorer);
        this.selectedNodeId = state.selectedNodeId;
        this.selectedEdgeId = state.selectedEdgeId;
        this.pinnedPositions = normalizeLearningGraphPinnedPositions(state.pinnedPositions);
    }

    async refresh(): Promise<void> {
        if (this.disposed) return;
        const revision = ++this.refreshRevision;
        try {
            const projection = await this.controller.getProjection();
            if (!this.isCurrentRefresh(revision)) return;
            this.projection = projection;
            this.render();
        } catch {
            if (!this.isCurrentRefresh(revision)) return;
            this.captureRendererLayout();
            this.renderer?.destroy();
            this.renderer = null;
            this.inspectorEl = null;
            this.clearSearchFocusTimer();
            this.contentEl.empty();
            this.contentEl.createDiv({ cls: "vault-coach-learning-map-error", text: this.t("learningMap.unavailable") });
        }
    }

    private render(): void {
        this.clearSearchFocusTimer();
        this.captureRendererLayout();
        this.renderer?.destroy();
        this.renderer = null;
        this.inspectorEl = null;
        this.contentEl.empty();
        this.contentEl.addClass("vault-coach-learning-map");
        const projection = this.projection;
        if (!projection) return;
        const indexState = this.application.index.getState();
        if (indexState.sourceInventoryStatus === "source-sync-required" || indexState.sourceInventoryStatus === "possible-domain-switch") {
            this.contentEl.createDiv({
                cls: "vault-coach-learning-map-empty",
                text: indexState.sourceInventoryStatus === "possible-domain-switch"
                    ? this.t("indexLifecycle.domainSwitch")
                    : this.t("indexLifecycle.sourceSyncRequired"),
            });
            return;
        }
        const semanticState = this.application.semanticGraph.getState();
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
        this.pinnedPositions = normalizeLearningGraphPinnedPositions(this.pinnedPositions, projection.nodes.map((node) => node.id));
        const confirmedCount = projection.edges.filter((edge) => edge.trust === "confirmed").length;
        const automaticCount = projection.edges.filter((edge) => edge.trust === "automatic").length;
        const body = this.contentEl.createDiv({ cls: "vault-coach-learning-map-body" });
        const graph = body.createDiv({ cls: "vault-coach-learning-map-graph" });
        this.renderer = new LearningGraphRenderer(graph, {
            nodes: projection.nodes,
            edges: projection.edges,
            initialPinnedPositions: this.pinnedPositions,
            accessibleTitle: this.t("learningMap.a11yTitle"),
            selectedNodeId: this.selectedNodeId,
            selectedEdgeId: this.selectedEdgeId,
            onSelectNode: (nodeId) => {
                if (this.selectedNodeId === nodeId) {
                    this.selectedNodeId = null;
                    this.selectedEdgeId = null;
                    this.renderer?.setSelection(null, null);
                    this.refreshInspector();
                    return;
                }
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
            onLayoutChanged: (pinnedPositions) => {
                this.pinnedPositions = { ...pinnedPositions };
            },
        });
        this.renderGraphControls(graph, projection, semanticState, confirmedCount, automaticCount);
        this.renderLegend(
            graph,
            automaticCount > 0,
            projection.nodes.some((node) => node.kind === "document" || node.kind === "section"),
            projection.nodes.some((node) => node.kind === "tag"),
            projection.edges.some((edge) => edge.trust === "structural"),
        );
        this.inspectorEl = this.contentEl.createDiv({ cls: "vault-coach-learning-map-inspector" });
        this.renderInspectorContent(this.inspectorEl, projection);
    }

    private renderGraphControls(
        graph: HTMLElement,
        projection: LearningGraphProjection,
        semanticState: SemanticGraphStateView,
        confirmedCount: number,
        automaticCount: number,
    ): void {
        const controls = graph.createDiv({ cls: "vault-coach-learning-map-controls" });
        const panels: HTMLElement[] = [];
        const closePanels = () => panels.forEach((panel) => panel.removeClass("is-open"));
        const togglePanel = (panel: HTMLElement) => {
            const shouldOpen = !panel.hasClass("is-open");
            closePanels();
            if (shouldOpen) panel.addClass("is-open");
        };

        const info = graph.createDiv({ cls: "vault-coach-learning-map-info-popover" });
        panels.push(info);
        info.createDiv({ text: this.t("learningMap.summary", {
            nodes: projection.stats.visibleNodeCount,
            relationships: projection.stats.visibleEdgeCount,
        }) });
        info.createDiv({ text: this.t("learningMap.relationshipSummary", { confirmed: confirmedCount, automatic: automaticCount }) });
        if (projection.stats.truncated) {
            info.createDiv({ text: this.t("learningMap.budget", {
                nodes: projection.stats.hiddenNodeCount,
                relationships: projection.stats.hiddenEdgeCount,
            }) });
        }
        if (semanticState.busy) this.renderSemanticBuildStatus(info, semanticState.progress);
        if (semanticState.capacity.level !== "local") {
            info.createDiv({ text: semanticState.capacity.level === "warning"
                ? this.t("learningMap.capacityWarning")
                : this.t("learningMap.capacityPaused") });
        }
        const infoButton = this.createGraphControlButton(controls, "info", this.t("learningMap.info"));
        infoButton.addEventListener("click", () => togglePanel(info));

        const searchPanel = graph.createDiv({ cls: "vault-coach-learning-map-search-popover" });
        panels.push(searchPanel);
        const search = searchPanel.createEl("input", {
            attr: { type: "search", placeholder: this.t("learningMap.search") },
        });
        search.value = this.controller.getSearch();
        const submitSearch = () => {
            this.controller.setSearch(search.value);
            void this.refresh();
        };
        search.addEventListener("change", submitSearch);
        search.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submitSearch();
        });
        const searchButton = this.createGraphControlButton(controls, "search", this.t("learningMap.search"));
        searchButton.addEventListener("click", () => {
            togglePanel(searchPanel);
            if (!searchPanel.hasClass("is-open")) return;
            this.clearSearchFocusTimer();
            this.searchFocusTimer = window.setTimeout(() => {
                this.searchFocusTimer = null;
                if (!this.disposed && searchPanel.isConnected) search.focus();
            }, 0);
        });

        const displayButton = this.createGraphControlButton(controls, "eye", this.t("learningMap.displaySettings"));
        displayButton.addEventListener("click", (event) => this.showDisplaySettingsMenu(event));
        const filterButton = this.createGraphControlButton(controls, "filter", this.t("learningMap.filterRelationships"));
        filterButton.addEventListener("click", (event) => this.showRelationshipFilterMenu(event));

        const fit = this.createGraphControlButton(controls, "scan", this.t("learningMap.fit"));
        fit.addEventListener("click", () => this.renderer?.fit());
        const canShowFull = projection.stats.sourceNodeCount <= LEARNING_GRAPH_MAX_NODES
            && projection.stats.sourceEdgeCount <= LEARNING_GRAPH_MAX_EDGES;
        if (canShowFull && (projection.stats.truncated || this.controller.isFullGraph())) {
            const full = this.createGraphControlButton(
                controls,
                this.controller.isFullGraph() ? "shrink" : "expand",
                this.controller.isFullGraph() ? this.t("learningMap.showOverview") : this.t("learningMap.showFull"),
            );
            full.addEventListener("click", () => {
                this.controller.setFullGraph(!this.controller.isFullGraph());
                void this.refresh();
            });
        }
        if (this.controller.canGoBack()) {
            const back = this.createGraphControlButton(controls, "undo-2", this.t("learningMap.back"));
            back.addEventListener("click", () => {
                if (!this.controller.goBack()) return;
                this.selectedNodeId = null;
                this.selectedEdgeId = null;
                void this.refresh();
            });
        }
        const reset = this.createGraphControlButton(controls, "rotate-ccw", this.t("learningMap.reset"));
        reset.addEventListener("click", () => {
            this.controller.reset();
            this.selectedNodeId = null;
            this.selectedEdgeId = null;
            void this.refresh();
        });
        if (!canShowFull && projection.stats.truncated) {
            info.createDiv({ text: this.t("learningMap.fullUnavailable") });
        }
    }

    private showDisplaySettingsMenu(event: MouseEvent): void {
        const menu = new Menu();
        menu.addItem((item) => item
            .setTitle(this.t("learningMap.showSource"))
            .setChecked(this.controller.hasStructuralContext())
            .onClick(() => {
                this.controller.setStructuralContext(!this.controller.hasStructuralContext());
                void this.refresh();
            }));
        menu.addItem((item) => item
            .setTitle(this.t("learningMap.showAutomatic"))
            .setChecked(this.controller.hasAutomaticRelationsVisible())
            .onClick(() => {
                this.controller.setAutomaticRelationsVisible(!this.controller.hasAutomaticRelationsVisible());
                void this.refresh();
            }));
        menu.showAtMouseEvent(event);
    }

    private showRelationshipFilterMenu(event: MouseEvent): void {
        const menu = new Menu();
        const selected = new Set(this.controller.getRelationTypes());
        for (const type of RELATION_TYPES) {
            const checked = selected.size === 0 || selected.has(type);
            menu.addItem((item) => item
                .setTitle(this.relationLabel(type))
                .setChecked(checked)
                .onClick(() => {
                const next = new Set(this.controller.getRelationTypes());
                if (next.size === 0) RELATION_TYPES.forEach((item) => next.add(item));
                if (checked) next.delete(type);
                else next.add(type);
                this.controller.setRelationTypes(Array.from(next));
                void this.refresh();
            }));
        }
        menu.showAtMouseEvent(event);
    }

    private createGraphControlButton(container: HTMLElement, icon: string, label: string): HTMLButtonElement {
        const button = container.createEl("button", {
            cls: "vault-coach-learning-map-control-button",
            attr: { "aria-label": label, title: label },
        });
        setIcon(button, icon);
        return button;
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
        const content = inspector.createDiv({ cls: "vault-coach-learning-map-inspector-content" });
        const details = content.createDiv({ cls: "vault-coach-learning-map-inspector-details" });
        const title = details.createDiv({ cls: "vault-coach-learning-map-inspector-title" });
        title.createEl("strong", { text: node.label });
        title.createSpan({ cls: "vault-coach-learning-map-concept-id", text: this.t("learningMap.conceptId", { id: node.id }) });
        details.createDiv({
            cls: "vault-coach-learning-map-description",
            text: node.description || this.t("learningMap.noDescription"),
            attr: { title: node.description || this.t("learningMap.noDescription") },
        });
        if (node.aliases.length > 0) {
            const aliases = this.t("learningMap.aliases", { aliases: node.aliases.join(", ") });
            details.createDiv({
                cls: "vault-coach-learning-map-inspector-line",
                text: aliases,
                attr: { title: aliases },
            });
        }
        const outgoing = projection.edges.filter((edge) => edge.sourceNodeId === node.id);
        const incoming = projection.edges.filter((edge) => edge.targetNodeId === node.id);
        const relationSummary = this.t("learningMap.relationshipCount", { outgoing: outgoing.length, incoming: incoming.length });
        const summary = node.kind === "concept"
            ? `${this.getMasterySummary(node.id)} · ${relationSummary}`
            : `${this.nodeKindLabel(node.kind)} · ${relationSummary}`;
        details.createDiv({ cls: "vault-coach-learning-map-muted vault-coach-learning-map-inspector-line", text: summary, attr: { title: summary } });
        const actions = content.createDiv({ cls: "vault-coach-learning-map-inspector-actions" });
        const focus = actions.createEl("button", { text: this.t("learningMap.focus"), cls: "mod-cta" });
        focus.addEventListener("click", () => { this.controller.setFocus(node.id); this.selectedEdgeId = null; void this.refresh(); });
        this.renderEvidenceSourceButton(actions, node.evidence);
        if (node.kind === "concept") this.renderSourceExamButton(actions, this.getExamSourcePaths(node));
    }

    private renderEdgeInspector(inspector: HTMLElement, edge: LearningGraphEdge, projection: LearningGraphProjection): void {
        const source = projection.nodes.find((node) => node.id === edge.sourceNodeId)?.label ?? edge.sourceNodeId;
        const target = projection.nodes.find((node) => node.id === edge.targetNodeId)?.label ?? edge.targetNodeId;
        const content = inspector.createDiv({ cls: "vault-coach-learning-map-inspector-content" });
        const details = content.createDiv({ cls: "vault-coach-learning-map-inspector-details" });
        details.createEl("h3", { text: this.relationLabel(edge.type) });
        details.createDiv({ text: `${source} ${edge.directed ? "→" : "—"} ${target}` });
        details.createDiv({
            cls: "vault-coach-learning-map-muted",
            text: this.t("learningMap.confidence", {
                trust: this.trustLabel(edge.trust),
                origin: this.originLabel(edge.origin),
                confidence: Math.round(edge.confidence * 100),
            }),
        });
        const actions = content.createDiv({ cls: "vault-coach-learning-map-inspector-actions" });
        this.renderEvidenceSourceButton(actions, edge.evidence);
    }

    private renderLegend(
        container: HTMLElement,
        includeAutomatic: boolean,
        includeStructuralNodes: boolean,
        includeTagNodes: boolean,
        includeStructuralRelations: boolean,
    ): void {
        const legend = container.createDiv({ cls: "vault-coach-learning-map-legend" });
        this.addLegendEntry(legend, "concept-node", this.t("learningMap.legend.conceptNode"));
        if (includeStructuralNodes) this.addLegendEntry(legend, "structural-node", this.t("learningMap.legend.structuralNode"));
        if (includeTagNodes) this.addLegendEntry(legend, "tag-node", this.t("learningMap.legend.tagNode"));
        this.addLegendEntry(legend, "confirmed", this.t("learningMap.legend.confirmed"));
        this.addLegendEntry(legend, "user", this.t("learningMap.legend.user"));
        if (includeAutomatic) this.addLegendEntry(legend, "automatic", this.t("learningMap.legend.automatic"));
        if (includeStructuralRelations) this.addLegendEntry(legend, "structural", this.t("learningMap.legend.structural"));
    }

    private addLegendEntry(
        container: HTMLElement,
        kind: "confirmed" | "user" | "automatic" | "structural" | "concept-node" | "structural-node" | "tag-node",
        label: string,
    ): void {
        const entry = container.createSpan({ cls: "vault-coach-learning-map-legend-entry" });
        entry.createSpan({ cls: `vault-coach-learning-map-legend-mark is-${kind}`, attr: { "aria-hidden": "true" } });
        entry.createSpan({ text: label });
    }

    private renderEvidenceSourceButton(container: HTMLElement, evidence: readonly LearningGraphEvidence[]): void {
        const sources = this.getEvidenceSources(evidence);
        const button = container.createEl("button", {
            text: this.t("learningMap.evidenceSources", { count: sources.length }),
            attr: sources.length === 0 ? { disabled: "true" } : {},
        });
        if (sources.length === 0) return;
        button.addEventListener("click", (event) => {
            const menu = new Menu();
            for (const source of sources) {
                menu.addItem((item) => item
                    .setTitle(source.label)
                    .onClick(() => void this.openEvidence(source.filePath, source.heading)));
            }
            menu.showAtMouseEvent(event);
        });
    }

    private renderSourceExamButton(container: HTMLElement, sourcePaths: readonly string[]): void {
        const canStart = sourcePaths.length > 0 && this.startExamForSources !== undefined;
        const button = container.createEl("button", {
            text: this.t("learningMap.sourceExam"),
            attr: canStart ? {} : { disabled: "true", title: this.t("learningMap.sourceExamUnavailable") },
        });
        if (!canStart) return;
        button.addEventListener("click", () => {
            void this.startExamForSources!(sourcePaths).catch(() => new Notice(this.t("learningMap.sourceExamUnavailable")));
        });
    }

    private getEvidenceSources(evidence: readonly LearningGraphEvidence[]): EvidenceSource[] {
        const sources = new Map<string, EvidenceSource>();
        for (const item of evidence) {
            if (item.kind === "user-decision") continue;
            const filePath = item.kind === "concept-evidence"
                ? item.locator.type === "zotero" ? "" : item.locator.filePath
                : item.source.sourceFilePath;
            if (!filePath) continue;
            const heading = item.kind === "concept-evidence" && item.locator.type === "markdown" ? item.locator.heading : undefined;
            const key = `${filePath}\u0000${heading ?? ""}`;
            sources.set(key, { filePath, heading, label: `${filePath}${heading ? ` › ${heading}` : ""}` });
        }
        return Array.from(sources.values()).sort((left, right) => left.label.localeCompare(right.label));
    }

    private getExamSourcePaths(node: LearningGraphNode): string[] {
        return Array.from(new Set([
            ...node.sourcePaths,
            ...this.getEvidenceSources(node.evidence).map((source) => source.filePath),
        ].filter((path) => path.length > 0))).sort((left, right) => left.localeCompare(right));
    }

    private getMasterySummary(conceptId: string): string {
        const masteryState = this.application.mastery.getState();
        const mastery = this.application.mastery.getConceptState(conceptId);
        if (!mastery) {
            if (masteryState.busy) return this.t("progress.mastery.calculating");
            return masteryState.dirty
                ? this.t("progress.mastery.stale")
                : this.t("learningMap.masteryUnavailable");
        }
        const summary = this.formatMasterySummary(mastery);
        return masteryState.dirty ? `${summary} · ${this.t("progress.mastery.stale")}` : summary;
    }

    private formatMasterySummary(mastery: ConceptMasteryState): string {
        return this.t("learningMap.masterySummary", {
            level: this.t(`progress.level.${mastery.level}` as TranslationKey),
            score: mastery.masteryScore === null ? this.t("learningMap.masteryNoScore") : `${Math.round(mastery.masteryScore * 100)}%`,
            confidence: Math.round(mastery.confidence * 100),
            trend: this.t(`learningMap.trend.${mastery.trend}` as TranslationKey),
            evidence: mastery.effectiveEvidenceCount,
        });
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

    private captureRendererLayout(): void {
        if (this.renderer) this.pinnedPositions = this.renderer.getPinnedPositions();
    }

    private clearSearchFocusTimer(): void {
        if (this.searchFocusTimer === null) return;
        window.clearTimeout(this.searchFocusTimer);
        this.searchFocusTimer = null;
    }

    private isCurrentRefresh(revision: number): boolean {
        return !this.disposed && revision === this.refreshRevision;
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

    private trustLabel(trust: LearningGraphEdge["trust"]): string {
        return this.t(`learningMap.trust.${trust}` as TranslationKey);
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }
}

function isLearningMapLeafState(value: unknown): value is LearningMapLeafState {
    if (!isRecord(value) || value.version !== LEARNING_MAP_LEAF_STATE_VERSION) return false;
    return isRecord(value.explorer)
        && (typeof value.selectedNodeId === "string" || value.selectedNodeId === null)
        && (typeof value.selectedEdgeId === "string" || value.selectedEdgeId === null)
        && isRecord(value.pinnedPositions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
