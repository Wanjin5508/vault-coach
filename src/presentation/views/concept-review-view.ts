import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { VaultCoachApplicationApi } from "../../app/application-api";
import { VIEW_TYPE_CONCEPT_REVIEW } from "../../constants";
import type {
    ConceptReviewProjection,
    EffectiveSemanticRelation,
    SemanticCandidate,
    SemanticConcept,
    SemanticRelationType,
    UserSemanticDecision,
} from "../../domain/semantic-graph/semantic-graph-types";
import { translate, type TranslationKey } from "../../i18n";
import { ConceptForceGraph } from "../components/concept-force-graph";
import { ConceptReviewController } from "../controllers/concept-review-controller";
import { requestSemanticGraphCapacityDecision } from "../modals/semantic-graph-capacity-modal";

/**
 * Main-workspace review surface. It renders at most one local projection and
 * never reads JSON shards, model clients, or Obsidian metadata directly.
 */
export class ConceptReviewView extends ItemView {
    private readonly controller: ConceptReviewController;
    private projection: ConceptReviewProjection | null = null;
    private selectedConceptIds = new Set<string>();
    private selectedCandidateFingerprint: string | null = null;
    private selectedRelationId: string | null = null;
    private isDisposed = false;
    private forceGraph: ConceptForceGraph | null = null;
    private inspectorEl: HTMLElement | null = null;
    /** Covers the synchronous gap before application events refresh this View. */
    private semanticRebuildInFlight = false;

    constructor(leaf: WorkspaceLeaf, application: VaultCoachApplicationApi) {
        super(leaf);
        this.controller = new ConceptReviewController(application.semanticGraph);
    }

    getViewType(): string { return VIEW_TYPE_CONCEPT_REVIEW; }
    getDisplayText(): string { return this.t("conceptReview.title"); }
    getIcon(): string { return "git-fork"; }

    async onOpen(): Promise<void> {
        await this.refresh();
    }

    async onClose(): Promise<void> {
        this.isDisposed = true;
        this.projection = null;
        this.selectedConceptIds.clear();
        this.selectedRelationId = null;
        this.forceGraph?.destroy();
        this.forceGraph = null;
        this.inspectorEl = null;
        this.contentEl.empty();
    }

    async refresh(): Promise<void> {
        if (this.isDisposed) return;
        try {
            this.projection = await this.controller.getProjection();
            if (!this.isDisposed) this.render();
        } catch {
            this.contentEl.empty();
            this.contentEl.createDiv({ cls: "vault-coach-concept-review-error", text: this.t("conceptReview.actionFailed") });
        }
    }

    private render(): void {
        const root = this.contentEl;
        this.forceGraph?.destroy();
        this.forceGraph = null;
        this.inspectorEl = null;
        root.empty();
        root.addClass("vault-coach-concept-review");
        const state = this.controller.getState();
        const header = root.createDiv({ cls: "vault-coach-concept-review-header" });
        const busy = state.busy || this.semanticRebuildInFlight;
        header.createEl("h2", { text: this.t("conceptReview.title") });
        header.createDiv({
            cls: "vault-coach-concept-review-summary",
            text: this.t("conceptReview.summary", {
                concepts: state.stats.conceptCount,
                pending: state.stats.pendingCandidateCount,
                confirmed: state.stats.confirmedRelationCount,
            }),
        });
        if (busy) this.renderSemanticBuildStatus(header, state.progress);
        if (!state.enabled) {
            root.createDiv({
                cls: "vault-coach-concept-review-notice",
                text: this.t("conceptReview.disabled"),
            });
        }
        if (state.capacity.level !== "local") {
            root.createDiv({
                cls: "vault-coach-concept-review-notice",
                text: state.capacity.level === "warning"
                    ? this.t("conceptReview.capacityWarning")
                    : this.t("conceptReview.capacityPaused"),
            });
        }
        if (state.sourceScope.skippedFileCount > 0) {
            root.createDiv({
                cls: "vault-coach-concept-review-notice",
                text: this.t("semantic.largeFilesSkipped", { count: state.sourceScope.skippedFileCount }),
            });
        }
        if (state.lastError) root.createDiv({ cls: "vault-coach-concept-review-warning", text: this.t("conceptReview.lastBuildFailed") });
        this.renderToolbar(root, busy);
        if (!this.projection || this.projection.concepts.length === 0) {
            root.createDiv({
                cls: "vault-coach-concept-review-empty",
                text: state.enabled ? this.t("conceptReview.empty") : this.t("conceptReview.emptyDisabled"),
            });
            return;
        }
        this.retainVisibleSelections(this.projection);
        const body = root.createDiv({ cls: "vault-coach-concept-review-body" });
        this.renderGraph(body, this.projection);
        this.renderInspector(body, this.projection);
    }

    private renderToolbar(root: HTMLElement, busy: boolean): void {
        const toolbar = root.createDiv({ cls: "vault-coach-concept-review-toolbar" });
        const search = toolbar.createEl("input", { attr: { type: "search", placeholder: this.t("conceptReview.search") } });
        search.value = this.controller.getSearch();
        search.addEventListener("change", () => {
            this.controller.setSearch(search.value);
            void this.refresh();
        });
        const pendingLabel = toolbar.createEl("label", { cls: "vault-coach-concept-review-toggle" });
        const pending = pendingLabel.createEl("input", { attr: { type: "checkbox" } });
        pending.checked = this.controller.isPendingVisible();
        pendingLabel.createSpan({ text: this.t("conceptReview.showPending") });
        pending.addEventListener("change", () => {
            this.controller.setPendingVisible(pending.checked);
            void this.refresh();
        });
        const rebuild = toolbar.createEl("button", {
            cls: "mod-cta vault-coach-semantic-build-button",
            attr: { "aria-busy": String(busy) },
        });
        if (busy) {
            rebuild.createSpan({ cls: "vault-coach-thinking-spinner", attr: { "aria-hidden": "true" } });
            rebuild.createSpan({ text: this.t("conceptReview.rebuilding") });
        } else {
            rebuild.setText(this.t("conceptReview.rebuild"));
        }
        rebuild.disabled = busy;
        rebuild.addEventListener("click", () => void this.rebuildSemanticGraph());
        const fit = toolbar.createEl("button", { text: this.t("conceptReview.fit") });
        fit.addEventListener("click", () => this.forceGraph?.fit());
        const reset = toolbar.createEl("button", { text: this.t("conceptReview.reset") });
        reset.addEventListener("click", () => {
            this.controller.focusConcept(undefined);
            this.selectedConceptIds.clear();
            this.selectedCandidateFingerprint = null;
            this.selectedRelationId = null;
            void this.refresh();
        });
        if (busy) {
            const abort = toolbar.createEl("button", { text: this.t("semantic.stop") });
            abort.addEventListener("click", () => { this.controller.abort(); void this.refresh(); });
        }
    }

    private renderGraph(container: HTMLElement, projection: ConceptReviewProjection): void {
        const graphArea = container.createDiv({ cls: "vault-coach-concept-review-graph" });
        this.forceGraph = new ConceptForceGraph(graphArea, {
            concepts: projection.concepts,
            relations: projection.relations,
            candidates: projection.candidates,
            selectedConceptIds: this.selectedConceptIds,
            onSelectConcept: (conceptId, multiSelect) => {
                if (!multiSelect) this.selectedConceptIds.clear();
                if (this.selectedConceptIds.has(conceptId)) this.selectedConceptIds.delete(conceptId);
                else this.selectedConceptIds.add(conceptId);
                this.selectedCandidateFingerprint = null;
                this.selectedRelationId = null;
                // Clicking is selection, not navigation. Rebuilding a local
                // projection here reset pan/zoom and made the graph appear to
                // jump. Neighbourhood navigation is now an explicit action in
                // the inspector.
                this.forceGraph?.setSelectedConceptIds(this.selectedConceptIds);
                this.refreshInspector();
            },
            onSelectCandidate: (fingerprint) => {
                this.selectedCandidateFingerprint = fingerprint;
                this.selectedConceptIds.clear();
                this.selectedRelationId = null;
                this.forceGraph?.setSelectedConceptIds(this.selectedConceptIds);
                this.refreshInspector();
            },
            onSelectRelation: (relationId) => {
                this.selectedRelationId = relationId;
                this.selectedCandidateFingerprint = null;
                this.selectedConceptIds.clear();
                this.forceGraph?.setSelectedConceptIds(this.selectedConceptIds);
                this.refreshInspector();
            },
        });
        graphArea.createDiv({
            cls: "vault-coach-concept-review-legend",
            text: this.t("conceptReview.legend", {
                visible: projection.concepts.length,
                total: projection.stats.conceptCount,
            }),
        });
    }

    private renderInspector(container: HTMLElement, projection: ConceptReviewProjection): void {
        const inspector = container.createDiv({ cls: "vault-coach-concept-review-inspector" });
        this.inspectorEl = inspector;
        this.renderInspectorContent(inspector, projection);
    }

    private refreshInspector(): void {
        if (!this.inspectorEl || !this.projection) return;
        this.inspectorEl.empty();
        this.renderInspectorContent(this.inspectorEl, this.projection);
    }

    private renderInspectorContent(inspector: HTMLElement, projection: ConceptReviewProjection): void {
        const selectedCandidate = projection.candidates.find((candidate) => candidate.fingerprint === this.selectedCandidateFingerprint);
        if (selectedCandidate) {
            this.renderCandidateInspector(inspector, selectedCandidate, projection);
            return;
        }
        const selectedRelation = projection.relations.find((relation) => relation.id === this.selectedRelationId);
        if (selectedRelation) {
            this.renderRelationInspector(inspector, selectedRelation, projection);
            return;
        }
        const selected = projection.concepts.filter((concept) => this.selectedConceptIds.has(concept.id));
        if (selected.length === 0) {
            inspector.createEl("h3", { text: this.t("conceptReview.inspector") });
            inspector.createDiv({ text: this.t("conceptReview.select") });
            this.renderDecisionHistory(inspector, projection);
            return;
        }
        if (selected.length > 1) {
            this.renderMultiConceptInspector(inspector, selected);
            return;
        }
        const concept = selected[0];
        if (concept) this.renderConceptInspector(inspector, concept);
    }

    private renderCandidateInspector(container: HTMLElement, candidate: SemanticCandidate, projection: ConceptReviewProjection): void {
        container.createEl("h3", { text: this.t("conceptReview.pendingRelationship") });
        const source = projection.concepts.find((concept) => concept.id === candidate.sourceConceptId)?.displayName ?? candidate.sourceConceptId;
        const target = projection.concepts.find((concept) => concept.id === candidate.targetConceptId)?.displayName ?? candidate.targetConceptId;
        container.createDiv({ text: this.formatRelationship(source, candidate.type, target) });
        container.createDiv({ cls: "vault-coach-concept-review-muted", text: `${this.originLabel(candidate.origin)} · ${Math.round(candidate.confidence * 100)}%` });
        this.renderEvidence(container, candidate.evidence);
        const actions = container.createDiv({ cls: "vault-coach-concept-review-actions" });
        const confirm = actions.createEl("button", { text: this.t("conceptReview.confirm"), cls: "mod-cta" });
        confirm.addEventListener("click", () => void this.runAction(() => this.controller.confirm(candidate.fingerprint)));
        const reason = container.createEl("input", { attr: { type: "text", placeholder: this.t("conceptReview.optionalRejectionReason") } });
        const reject = actions.createEl("button", { text: this.t("conceptReview.reject") });
        reject.addEventListener("click", () => void this.runAction(() => this.controller.reject(candidate.fingerprint, reason.value || undefined)));
    }

    private renderRelationInspector(container: HTMLElement, relation: EffectiveSemanticRelation, projection: ConceptReviewProjection): void {
        container.createEl("h3", { text: relation.origin === "user" ? this.t("conceptReview.manualRelationship") : this.t("conceptReview.confirmedRelationship") });
        const source = projection.concepts.find((concept) => concept.id === relation.sourceConceptId)?.displayName ?? relation.sourceConceptId;
        const target = projection.concepts.find((concept) => concept.id === relation.targetConceptId)?.displayName ?? relation.targetConceptId;
        container.createDiv({ text: this.formatRelationship(source, relation.type, target) });
        container.createDiv({ cls: "vault-coach-concept-review-muted", text: `${this.originLabel(relation.origin)} · ${Math.round(relation.confidence * 100)}%` });
        this.renderEvidence(container, relation.evidence);
        const actions = container.createDiv({ cls: "vault-coach-concept-review-actions" });
        if (relation.origin === "user") {
            const remove = actions.createEl("button", { text: this.t("conceptReview.removeManual"), cls: "mod-warning" });
            remove.addEventListener("click", () => void this.runAction(() => this.controller.removeManualRelation(relation.id)));
            return;
        }
        const decision = findActiveCandidateDecision(projection.decisions, relation.candidateFingerprint);
        if (decision) {
            const undo = actions.createEl("button", { text: this.t("conceptReview.revertPending") });
            undo.addEventListener("click", () => void this.runAction(() => this.controller.undoCandidateDecision(decision.id)));
        }
    }

    private renderConceptInspector(container: HTMLElement, concept: SemanticConcept): void {
        container.createEl("h3", { text: concept.displayName });
        container.createDiv({ cls: "vault-coach-concept-review-muted", text: concept.id });
        if (concept.description) container.createDiv({ text: concept.description });
        container.createEl("h4", { text: this.t("conceptReview.aliases") });
        const aliases = container.createDiv({ cls: "vault-coach-concept-review-aliases" });
        for (const alias of concept.aliases) {
            const aliasRow = aliases.createDiv({ cls: "vault-coach-concept-review-alias" });
            aliasRow.createSpan({ text: alias });
            const remove = aliasRow.createEl("button", { text: "×", attr: { "aria-label": this.t("conceptReview.removeAlias", { alias }) } });
            remove.addEventListener("click", () => void this.runAction(() => this.controller.removeAlias(concept.id, alias)));
        }
        const alias = container.createEl("input", { attr: { type: "text", placeholder: this.t("conceptReview.newAlias") } });
        const addAlias = container.createEl("button", { text: this.t("conceptReview.addAlias") });
        addAlias.addEventListener("click", () => {
            if (alias.value.trim()) void this.runAction(() => this.controller.addAlias(concept.id, alias.value));
        });
        this.renderEvidence(container, concept.evidence);
        const focus = container.createEl("button", { text: this.t("conceptReview.focus") });
        focus.addEventListener("click", () => {
            this.controller.focusConcept(concept.id);
            this.selectedCandidateFingerprint = null;
            this.selectedRelationId = null;
            void this.refresh();
        });
    }

    private renderMultiConceptInspector(container: HTMLElement, concepts: readonly SemanticConcept[]): void {
        container.createEl("h3", { text: this.t("conceptReview.selectedConcepts", { count: concepts.length }) });
        const canonical = container.createEl("select");
        for (const concept of concepts) canonical.createEl("option", { value: concept.id, text: concept.displayName });
        const merge = container.createEl("button", { text: this.t("conceptReview.merge"), cls: "mod-warning" });
        merge.addEventListener("click", () => void this.runAction(() => this.controller.merge(canonical.value, concepts.map((concept) => concept.id).filter((id) => id !== canonical.value))));
        container.createEl("h4", { text: this.t("conceptReview.manualRelation") });
        const relation = container.createEl("select");
        for (const type of ["same_as", "part_of", "prerequisite_of", "used_for", "contrasts_with", "related_to"] as SemanticRelationType[]) {
            relation.createEl("option", { value: type, text: this.relationLabel(type) });
        }
        const note = container.createEl("textarea", { attr: { placeholder: this.t("conceptReview.notePlaceholder") } });
        const create = container.createEl("button", { text: this.t("conceptReview.createManual") });
        create.addEventListener("click", () => void this.runAction(() => this.controller.createManualRelation(
            relation.value as SemanticRelationType,
            concepts[0]?.id ?? "",
            concepts[1]?.id ?? "",
            note.value,
        )));
    }

    private renderDecisionHistory(container: HTMLElement, projection: ConceptReviewProjection): void {
        const entries = getUndoableDecisions(projection.decisions);
        if (entries.length === 0) return;
        container.createEl("h4", { text: this.t("conceptReview.recentChanges") });
        const history = container.createDiv({ cls: "vault-coach-concept-review-history" });
        for (const decision of entries.slice(-8).reverse()) {
            const row = history.createDiv({ cls: "vault-coach-concept-review-history-row" });
            row.createSpan({ text: this.describeDecision(decision) });
            const undo = row.createEl("button", { text: this.t("conceptReview.undo") });
            if (decision.kind === "confirm-candidate" || decision.kind === "reject-candidate") {
                undo.addEventListener("click", () => void this.runAction(() => this.controller.undoCandidateDecision(decision.id)));
            } else if (decision.kind === "remove-manual-relation") {
                undo.addEventListener("click", () => void this.runAction(() => this.controller.undoManualRelationRemoval(decision.id)));
            } else {
                undo.addEventListener("click", () => void this.runAction(() => this.controller.undoMerge(decision.id)));
            }
        }
    }

    private renderEvidence(container: HTMLElement, evidence: readonly { chunkId: string; textPreview: string; sectionId: string }[]): void {
        container.createEl("h4", { text: this.t("conceptReview.evidence") });
        if (evidence.length === 0) {
            container.createDiv({ cls: "vault-coach-concept-review-muted", text: this.t("conceptReview.userCreatedEvidence") });
            return;
        }
        const list = container.createEl("ul", { cls: "vault-coach-concept-review-evidence" });
        for (const item of evidence.slice(0, 4)) list.createEl("li", { text: `${item.chunkId}: ${truncate(item.textPreview, 180)}` });
    }

    private async runAction(action: () => Promise<void>): Promise<void> {
        try {
            await action();
            await this.refresh();
        } catch {
            new Notice(this.t("conceptReview.actionFailed"));
        }
    }

    private async rebuildSemanticGraph(): Promise<void> {
        if (this.semanticRebuildInFlight || this.controller.getState().busy) return;
        const capacity = this.controller.getState().capacity;
        if (!await requestSemanticGraphCapacityDecision(this.app, capacity, (key, replacements) => this.t(key, replacements))) {
            return;
        }
        this.semanticRebuildInFlight = true;
        this.render();
        try {
            await this.controller.rebuild();
        } catch (error: unknown) {
            const message = error instanceof Error && error.message.trim().length > 0
                ? error.message
                : this.t("conceptReview.actionFailed");
            new Notice(message, 10_000);
        } finally {
            this.semanticRebuildInFlight = false;
            await this.refresh();
        }
    }

    private renderSemanticBuildStatus(
        container: HTMLElement,
        progress: { totalSections: number; processedSections: number; queuedSections: number },
    ): void {
        const status = container.createDiv({
            cls: "vault-coach-semantic-build-status",
            attr: { role: "status", "aria-live": "polite" },
        });
        status.createSpan({ cls: "vault-coach-thinking-spinner", attr: { "aria-hidden": "true" } });
        const text = progress.totalSections > 0
            ? this.t("semantic.buildingProgress", { processed: progress.processedSections, total: progress.totalSections })
            : this.t("semantic.building");
        status.createSpan({ text });
        if (progress.totalSections > 0) {
            status.createEl("progress", {
                cls: "vault-coach-semantic-build-progress",
                attr: {
                    max: String(progress.totalSections),
                    value: String(Math.min(progress.totalSections, progress.processedSections)),
                },
            });
        }
        status.createSpan({ cls: "vault-coach-semantic-build-wait", text: this.t("semantic.buildingWait") });
    }

    private formatRelationship(source: string, type: SemanticRelationType, target: string): string {
        const connector = type === "same_as" || type === "related_to" || type === "contrasts_with" ? " ↔ " : " → ";
        return `${source}${connector}${target} (${this.relationLabel(type)})`;
    }

    private relationLabel(type: SemanticRelationType): string {
        return this.t(`semantic.relation.${type}` as TranslationKey);
    }

    private originLabel(origin: "model" | "rule" | "similarity" | "user"): string {
        return this.t(`semantic.origin.${origin}` as TranslationKey);
    }

    private describeDecision(decision: ReturnType<typeof getUndoableDecisions>[number]): string {
        if (decision.kind === "confirm-candidate") {
            return this.t("conceptReview.decision.confirmed", { id: shortId(decision.candidateFingerprint) });
        }
        if (decision.kind === "reject-candidate") {
            return this.t("conceptReview.decision.rejected", { id: shortId(decision.candidateFingerprint) });
        }
        if (decision.kind === "remove-manual-relation") {
            return this.t("conceptReview.decision.removed", { id: shortId(decision.relationId) });
        }
        return this.t("conceptReview.decision.merged", { count: decision.mergedConceptIds.length });
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    private retainVisibleSelections(projection: ConceptReviewProjection): void {
        const visibleIds = new Set(projection.concepts.map((concept) => concept.id));
        for (const conceptId of this.selectedConceptIds) {
            if (!visibleIds.has(conceptId)) this.selectedConceptIds.delete(conceptId);
        }
        if (this.selectedCandidateFingerprint && !projection.candidates.some((candidate) => candidate.fingerprint === this.selectedCandidateFingerprint)) {
            this.selectedCandidateFingerprint = null;
        }
        if (this.selectedRelationId && !projection.relations.some((relation) => relation.id === this.selectedRelationId)) {
            this.selectedRelationId = null;
        }
    }
}

function findActiveCandidateDecision(
    decisions: readonly UserSemanticDecision[],
    candidateFingerprint: string | undefined,
): Extract<UserSemanticDecision, { kind: "confirm-candidate" | "reject-candidate" }> | null {
    if (!candidateFingerprint) return null;
    const undone = new Set(decisions
        .filter((decision): decision is Extract<UserSemanticDecision, { kind: "undo-candidate-decision" }> => decision.kind === "undo-candidate-decision")
        .map((decision) => decision.supersedesDecisionId));
    const matching = decisions.filter((decision): decision is Extract<UserSemanticDecision, { kind: "confirm-candidate" | "reject-candidate" }> => (
        (decision.kind === "confirm-candidate" || decision.kind === "reject-candidate")
        && decision.candidateFingerprint === candidateFingerprint
        && !undone.has(decision.id)
    ));
    return matching.at(-1) ?? null;
}

function getUndoableDecisions(decisions: readonly UserSemanticDecision[]): Array<
    Extract<UserSemanticDecision, { kind: "confirm-candidate" | "reject-candidate" | "remove-manual-relation" | "merge-concepts" }>
> {
    const undoneCandidate = new Set(decisions
        .filter((decision): decision is Extract<UserSemanticDecision, { kind: "undo-candidate-decision" }> => decision.kind === "undo-candidate-decision")
        .map((decision) => decision.supersedesDecisionId));
    const undoneManualRemoval = new Set(decisions
        .filter((decision): decision is Extract<UserSemanticDecision, { kind: "undo-manual-relation-removal" }> => decision.kind === "undo-manual-relation-removal")
        .map((decision) => decision.supersedesDecisionId));
    const undoneMerge = new Set(decisions
        .filter((decision): decision is Extract<UserSemanticDecision, { kind: "undo-merge" }> => decision.kind === "undo-merge")
        .map((decision) => decision.supersedesDecisionId));
    const latestCandidateDecisionId = new Map<string, string>();
    for (const decision of decisions) {
        if ((decision.kind === "confirm-candidate" || decision.kind === "reject-candidate") && !undoneCandidate.has(decision.id)) {
            latestCandidateDecisionId.set(decision.candidateFingerprint, decision.id);
        }
    }
    return decisions.filter((decision): decision is Extract<UserSemanticDecision, { kind: "confirm-candidate" | "reject-candidate" | "remove-manual-relation" | "merge-concepts" }> => {
        if (decision.kind === "confirm-candidate" || decision.kind === "reject-candidate") {
            return !undoneCandidate.has(decision.id) && latestCandidateDecisionId.get(decision.candidateFingerprint) === decision.id;
        }
        if (decision.kind === "remove-manual-relation") return !undoneManualRemoval.has(decision.id);
        if (decision.kind === "merge-concepts") return !undoneMerge.has(decision.id);
        return false;
    });
}

function shortId(value: string): string {
    return value.length > 18 ? `${value.slice(0, 17)}…` : value;
}

function truncate(value: string, length: number): string {
    return value.length > length ? `${value.slice(0, Math.max(1, length - 1))}…` : value;
}
