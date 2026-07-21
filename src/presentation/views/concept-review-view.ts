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
import { ConceptForceGraph } from "../components/concept-force-graph";
import { ConceptReviewController } from "../controllers/concept-review-controller";

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

    constructor(leaf: WorkspaceLeaf, application: VaultCoachApplicationApi) {
        super(leaf);
        this.controller = new ConceptReviewController(application.semanticGraph);
    }

    getViewType(): string { return VIEW_TYPE_CONCEPT_REVIEW; }
    getDisplayText(): string { return "Concept review"; }
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
        } catch (error: unknown) {
            this.contentEl.empty();
            this.contentEl.createDiv({ cls: "vault-coach-concept-review-error", text: describeError(error) });
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
        header.createEl("h2", { text: "Concept review" });
        header.createDiv({
            cls: "vault-coach-concept-review-summary",
            text: `${state.stats.conceptCount} concepts · ${state.stats.pendingCandidateCount} pending candidates · ${state.stats.confirmedRelationCount} confirmed relations`,
        });
        if (!state.enabled) {
            root.createDiv({
                cls: "vault-coach-concept-review-notice",
                text: "Semantic concept graph is disabled. Enable it in Settings → VaultCoach, then rebuild from this view or the command palette. No note content is sent until you explicitly enable and run it.",
            });
        }
        if (state.lastError) root.createDiv({ cls: "vault-coach-concept-review-warning", text: state.lastError });
        this.renderToolbar(root, state.busy);
        if (!this.projection || this.projection.concepts.length === 0) {
            root.createDiv({
                cls: "vault-coach-concept-review-empty",
                text: state.enabled ? "No verified concept candidates yet. Run a semantic graph rebuild after the deterministic graph and text index are ready." : "Enable the feature before creating a semantic graph.",
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
        const search = toolbar.createEl("input", { attr: { type: "search", placeholder: "Search concepts" } });
        search.value = this.controller.getSearch();
        search.addEventListener("change", () => {
            this.controller.setSearch(search.value);
            void this.refresh();
        });
        const pendingLabel = toolbar.createEl("label", { cls: "vault-coach-concept-review-toggle" });
        const pending = pendingLabel.createEl("input", { attr: { type: "checkbox" } });
        pending.checked = this.controller.isPendingVisible();
        pendingLabel.createSpan({ text: "Show pending candidates" });
        pending.addEventListener("change", () => {
            this.controller.setPendingVisible(pending.checked);
            void this.refresh();
        });
        const rebuild = toolbar.createEl("button", { text: busy ? "Building…" : "Rebuild semantic graph", cls: "mod-cta" });
        rebuild.disabled = busy;
        rebuild.addEventListener("click", () => void this.runAction(() => this.controller.rebuild()));
        const fit = toolbar.createEl("button", { text: "Fit graph" });
        fit.addEventListener("click", () => this.forceGraph?.fit());
        const reset = toolbar.createEl("button", { text: "Reset local graph" });
        reset.addEventListener("click", () => {
            this.controller.focusConcept(undefined);
            this.selectedConceptIds.clear();
            this.selectedCandidateFingerprint = null;
            this.selectedRelationId = null;
            void this.refresh();
        });
        if (busy) {
            const abort = toolbar.createEl("button", { text: "Stop" });
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
            text: `Showing ${projection.concepts.length} local concepts from ${projection.stats.conceptCount}. Search or focus a node to inspect another local neighbourhood. Drag nodes, drag empty space to pan, scroll to zoom. Arrows show direction; solid = confirmed; dashed = pending. Ctrl/Cmd-click selects multiple nodes.`,
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
            inspector.createEl("h3", { text: "Inspector" });
            inspector.createDiv({ text: "Select a node or relationship to inspect its evidence and decision actions." });
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
        container.createEl("h3", { text: "Pending relationship" });
        const source = projection.concepts.find((concept) => concept.id === candidate.sourceConceptId)?.displayName ?? candidate.sourceConceptId;
        const target = projection.concepts.find((concept) => concept.id === candidate.targetConceptId)?.displayName ?? candidate.targetConceptId;
        container.createDiv({ text: formatRelationship(source, candidate.type, target) });
        container.createDiv({ cls: "vault-coach-concept-review-muted", text: `${candidate.origin} · ${Math.round(candidate.confidence * 100)}%` });
        this.renderEvidence(container, candidate.evidence);
        const actions = container.createDiv({ cls: "vault-coach-concept-review-actions" });
        const confirm = actions.createEl("button", { text: "Confirm", cls: "mod-cta" });
        confirm.addEventListener("click", () => void this.runAction(() => this.controller.confirm(candidate.fingerprint)));
        const reason = container.createEl("input", { attr: { type: "text", placeholder: "Optional rejection reason" } });
        const reject = actions.createEl("button", { text: "Reject" });
        reject.addEventListener("click", () => void this.runAction(() => this.controller.reject(candidate.fingerprint, reason.value || undefined)));
    }

    private renderRelationInspector(container: HTMLElement, relation: EffectiveSemanticRelation, projection: ConceptReviewProjection): void {
        container.createEl("h3", { text: relation.origin === "user" ? "Manual relationship" : "Confirmed relationship" });
        const source = projection.concepts.find((concept) => concept.id === relation.sourceConceptId)?.displayName ?? relation.sourceConceptId;
        const target = projection.concepts.find((concept) => concept.id === relation.targetConceptId)?.displayName ?? relation.targetConceptId;
        container.createDiv({ text: formatRelationship(source, relation.type, target) });
        container.createDiv({ cls: "vault-coach-concept-review-muted", text: `${relation.origin} · ${Math.round(relation.confidence * 100)}%` });
        this.renderEvidence(container, relation.evidence);
        const actions = container.createDiv({ cls: "vault-coach-concept-review-actions" });
        if (relation.origin === "user") {
            const remove = actions.createEl("button", { text: "Remove manual relation", cls: "mod-warning" });
            remove.addEventListener("click", () => void this.runAction(() => this.controller.removeManualRelation(relation.id)));
            return;
        }
        const decision = findActiveCandidateDecision(projection.decisions, relation.candidateFingerprint);
        if (decision) {
            const undo = actions.createEl("button", { text: "Revert to pending candidate" });
            undo.addEventListener("click", () => void this.runAction(() => this.controller.undoCandidateDecision(decision.id)));
        }
    }

    private renderConceptInspector(container: HTMLElement, concept: SemanticConcept): void {
        container.createEl("h3", { text: concept.displayName });
        container.createDiv({ cls: "vault-coach-concept-review-muted", text: concept.id });
        if (concept.description) container.createDiv({ text: concept.description });
        container.createEl("h4", { text: "Aliases" });
        const aliases = container.createDiv({ cls: "vault-coach-concept-review-aliases" });
        for (const alias of concept.aliases) {
            const aliasRow = aliases.createDiv({ cls: "vault-coach-concept-review-alias" });
            aliasRow.createSpan({ text: alias });
            const remove = aliasRow.createEl("button", { text: "×", attr: { "aria-label": `Remove ${alias}` } });
            remove.addEventListener("click", () => void this.runAction(() => this.controller.removeAlias(concept.id, alias)));
        }
        const alias = container.createEl("input", { attr: { type: "text", placeholder: "New alias" } });
        const addAlias = container.createEl("button", { text: "Add alias" });
        addAlias.addEventListener("click", () => {
            if (alias.value.trim()) void this.runAction(() => this.controller.addAlias(concept.id, alias.value));
        });
        this.renderEvidence(container, concept.evidence);
        const focus = container.createEl("button", { text: "Focus local neighbourhood" });
        focus.addEventListener("click", () => {
            this.controller.focusConcept(concept.id);
            this.selectedCandidateFingerprint = null;
            this.selectedRelationId = null;
            void this.refresh();
        });
    }

    private renderMultiConceptInspector(container: HTMLElement, concepts: readonly SemanticConcept[]): void {
        container.createEl("h3", { text: `${concepts.length} selected concepts` });
        const canonical = container.createEl("select");
        for (const concept of concepts) canonical.createEl("option", { value: concept.id, text: concept.displayName });
        const merge = container.createEl("button", { text: "Merge selected concepts", cls: "mod-warning" });
        merge.addEventListener("click", () => void this.runAction(() => this.controller.merge(canonical.value, concepts.map((concept) => concept.id).filter((id) => id !== canonical.value))));
        container.createEl("h4", { text: "Manual relation" });
        const relation = container.createEl("select");
        for (const type of ["same_as", "part_of", "prerequisite_of", "used_for", "contrasts_with", "related_to"] as SemanticRelationType[]) {
            relation.createEl("option", { value: type, text: type });
        }
        const note = container.createEl("textarea", { attr: { placeholder: "Required user note when no chunk evidence is selected" } });
        const create = container.createEl("button", { text: "Create manual relation" });
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
        container.createEl("h4", { text: "Recent reversible changes" });
        const history = container.createDiv({ cls: "vault-coach-concept-review-history" });
        for (const decision of entries.slice(-8).reverse()) {
            const row = history.createDiv({ cls: "vault-coach-concept-review-history-row" });
            row.createSpan({ text: describeDecision(decision) });
            const undo = row.createEl("button", { text: "Undo" });
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
        container.createEl("h4", { text: "Evidence" });
        if (evidence.length === 0) {
            container.createDiv({ cls: "vault-coach-concept-review-muted", text: "User-created relation with an explicit note." });
            return;
        }
        const list = container.createEl("ul", { cls: "vault-coach-concept-review-evidence" });
        for (const item of evidence.slice(0, 4)) list.createEl("li", { text: `${item.chunkId}: ${truncate(item.textPreview, 180)}` });
    }

    private async runAction(action: () => Promise<void>): Promise<void> {
        try {
            await action();
            await this.refresh();
        } catch (error: unknown) {
            new Notice(describeError(error));
        }
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

function formatRelationship(source: string, type: SemanticRelationType, target: string): string {
    const connector = type === "same_as" || type === "related_to" || type === "contrasts_with" ? " ↔ " : " → ";
    return `${source}${connector}${target} (${type})`;
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

function describeDecision(decision: ReturnType<typeof getUndoableDecisions>[number]): string {
    if (decision.kind === "confirm-candidate") return `Confirmed candidate ${shortId(decision.candidateFingerprint)}`;
    if (decision.kind === "reject-candidate") return `Rejected candidate ${shortId(decision.candidateFingerprint)}`;
    if (decision.kind === "remove-manual-relation") return `Removed manual relationship ${shortId(decision.relationId)}`;
    return `Merged ${decision.mergedConceptIds.length} concept(s)`;
}

function shortId(value: string): string {
    return value.length > 18 ? `${value.slice(0, 17)}…` : value;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, length: number): string {
    return value.length > length ? `${value.slice(0, Math.max(1, length - 1))}…` : value;
}
