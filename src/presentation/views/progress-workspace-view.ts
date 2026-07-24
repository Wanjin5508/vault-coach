import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { VaultCoachApplicationApi } from "../../app/application-api";
import type { ProgressSnapshot } from "../../app/progress/progress-types";
import { VIEW_TYPE_PROGRESS } from "../../constants";
import { translate, type TranslationKey } from "../../i18n";
import { formatDateTime } from "../../ui/view-formatters";
import { createProgressDashboardModel, type ProgressDashboardCard } from "../components/progress-dashboard-model";
import { ProgressController } from "../controllers/progress-controller";

export type LearningMapWorkspaceOpener = () => Promise<void>;

/**
 * Main-workspace shell for the Learning dashboard.
 *
 * It consumes a disposable ProgressSnapshot only after the user opens this
 * workspace. Graph rendering and Learning Map navigation remain separate.
 */
export class ProgressWorkspaceView extends ItemView {
    private readonly controller: ProgressController;
    private disposed = false;
    private snapshot: ProgressSnapshot | null = null;
    private loading = false;
    private loadError: string | null = null;
    private refreshRevision = 0;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly application: VaultCoachApplicationApi,
        private readonly openLearningMap: LearningMapWorkspaceOpener,
    ) {
        super(leaf);
        this.controller = new ProgressController(application.progress);
    }

    getViewType(): string { return VIEW_TYPE_PROGRESS; }
    getDisplayText(): string { return this.t("progress.title"); }
    getIcon(): string { return "chart-line"; }

    async onOpen(): Promise<void> {
        await this.refresh();
    }

    async onClose(): Promise<void> {
        this.disposed = true;
        this.refreshRevision += 1;
        this.snapshot = null;
        this.controller.dispose();
        this.contentEl.empty();
        this.contentEl.removeClass("vault-coach-progress-workspace");
    }

    async refresh(): Promise<void> {
        if (this.disposed) return;
        const state = this.controller.getState();
        if (!state.available) {
            this.snapshot = null;
            this.loading = false;
            this.render();
            return;
        }

        const requestRevision = ++this.refreshRevision;
        this.loading = true;
        this.loadError = null;
        this.render();
        try {
            const snapshot = await this.controller.getSnapshot();
            if (this.isCurrentRequest(requestRevision)) this.snapshot = snapshot;
        } catch {
            // Keep operational error details out of locale-controlled UI. The
            // retry action remains available and diagnostics stay in the console.
            if (this.isCurrentRequest(requestRevision)) this.loadError = "load-failed";
        } finally {
            if (this.isCurrentRequest(requestRevision)) {
                this.loading = false;
                this.render();
            }
        }
    }

    private render(): void {
        this.contentEl.empty();
        this.contentEl.addClass("vault-coach-progress-workspace");

        const header = this.contentEl.createDiv({ cls: "vault-coach-progress-workspace-header" });
        header.createEl("h2", { text: this.t("progress.title") });
        header.createDiv({
            cls: "vault-coach-progress-workspace-summary",
            text: this.t("progress.summary"),
        });

        const indexState = this.application.index.getState();
        if (indexState.sourceInventoryStatus === "source-sync-required" || indexState.sourceInventoryStatus === "possible-domain-switch") {
            this.contentEl.createDiv({
                cls: "vault-coach-progress-workspace-message is-error",
                text: indexState.sourceInventoryStatus === "possible-domain-switch"
                    ? this.t("indexLifecycle.domainSwitch")
                    : this.t("indexLifecycle.sourceSyncRequired"),
            });
            return;
        }

        const state = this.controller.getState();
        if (!state.available) {
            this.contentEl.createDiv({
                cls: "vault-coach-progress-workspace-message is-error",
                text: this.t("progress.unavailable"),
            });
            return;
        }

        if (!this.snapshot) {
            this.renderLoadingOrError();
            return;
        }

        this.renderDashboard();
    }

    private renderLoadingOrError(): void {
        const message = this.contentEl.createDiv({
            cls: `vault-coach-progress-workspace-message${this.loadError ? " is-error" : ""}`,
            attr: { "aria-live": "polite" },
        });
        if (this.loadError) {
            message.createDiv({ text: this.t("progress.loadFailed") });
            const retry = message.createEl("button", { text: this.t("progress.retry"), attr: { type: "button" } });
            retry.addEventListener("click", () => { void this.refresh(); });
            return;
        }
        message.createDiv({ text: this.loading ? this.t("progress.loading") : this.t("progress.empty") });
    }

    private renderDashboard(): void {
        const snapshot = this.snapshot;
        if (!snapshot) return;
        const state = this.controller.getState();
        const capacity = this.application.semanticGraph.getState().capacity;
        const model = createProgressDashboardModel(snapshot, state, capacity, translate);
        const freshness = this.contentEl.createDiv({
            cls: `vault-coach-progress-freshness is-${model.freshness.tone}`,
            attr: { "aria-live": "polite" },
        });
        freshness.createSpan({ text: model.freshness.message });
        freshness.createSpan({
            cls: "vault-coach-progress-workspace-muted",
            text: this.t("progress.generatedAt", { time: formatDateTime(model.generatedAt) }),
        });

        if (this.loadError) {
            this.contentEl.createDiv({
                cls: "vault-coach-progress-dashboard-warning",
                text: this.t("progress.freshness.failed"),
            });
        }

        const cards = this.contentEl.createDiv({ cls: "vault-coach-progress-dashboard-cards" });
        model.cards.forEach((card) => this.renderCard(cards, card));

        const detailGrid = this.contentEl.createDiv({ cls: "vault-coach-progress-dashboard-detail-grid" });
        const distribution = detailGrid.createDiv({ cls: "vault-coach-progress-dashboard-panel" });
        distribution.createEl("h3", { text: this.t("progress.masteryDistribution") });
        const levels = distribution.createDiv({ cls: "vault-coach-progress-levels" });
        for (const level of model.levels) {
            const row = levels.createDiv({ cls: `vault-coach-progress-level is-${level.level}` });
            row.createSpan({ text: level.label });
            row.createSpan({ text: String(level.count) });
        }

        const health = detailGrid.createDiv({ cls: "vault-coach-progress-dashboard-panel" });
        health.createEl("h3", { text: this.t("progress.localDataHealth") });
        health.createDiv({ text: model.capacity.message, cls: `vault-coach-progress-status is-${model.capacity.tone}` });
        if (model.latestAssessmentAt !== null) {
            health.createDiv({
                cls: "vault-coach-progress-workspace-muted",
                text: this.t("progress.latestAssessment", { time: formatDateTime(model.latestAssessmentAt) }),
            });
        }
        health.createDiv({
            cls: "vault-coach-progress-workspace-muted",
            text: this.t("progress.recommendationsPending"),
        });

        const actions = this.contentEl.createDiv({ cls: "vault-coach-progress-dashboard-actions" });
        const openLearningMapButton = actions.createEl("button", {
            text: this.t("progress.openLearningMap"),
            attr: { type: "button" },
        });
        openLearningMapButton.addEventListener("click", () => { void this.openLearningMap(); });
    }

    private renderCard(container: HTMLElement, card: ProgressDashboardCard): void {
        const root = container.createDiv({ cls: `vault-coach-progress-dashboard-card is-${card.tone}` });
        root.createDiv({ cls: "vault-coach-progress-dashboard-card-label", text: card.label });
        root.createDiv({ cls: "vault-coach-progress-dashboard-card-value", text: card.value });
        root.createDiv({ cls: "vault-coach-progress-dashboard-card-detail", text: card.detail });
    }

    private isCurrentRequest(requestRevision: number): boolean {
        return !this.disposed && requestRevision === this.refreshRevision;
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }
}
