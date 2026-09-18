import { ItemView, Menu, Notice, type WorkspaceLeaf } from "obsidian";
import type { VaultCoachApplicationApi } from "../../app/application-api";
import type { ProgressSnapshot } from "../../app/progress/progress-types";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation-types";
import { VIEW_TYPE_PROGRESS } from "../../constants";
import { translate, type TranslationKey } from "../../i18n";
import { formatDateTime } from "../../ui/view-formatters";
import { createProgressDashboardModel, type ProgressDashboardCard } from "../components/progress-dashboard-model";
import { ProgressController } from "../controllers/progress-controller";

export type LearningMapWorkspaceOpener = () => Promise<void>;
export type ProgressRecommendationSourceOpener = (sourcePath: string) => Promise<void>;
export type ProgressRecommendationExamStarter = (sourcePaths: readonly string[]) => Promise<void>;

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
    private recommendationSnapshot: RecommendationSnapshot | null = null;
    private loading = false;
    private loadError: string | null = null;
    private refreshRevision = 0;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly application: VaultCoachApplicationApi,
        private readonly openLearningMap: LearningMapWorkspaceOpener,
        private readonly openRecommendationSources?: ProgressRecommendationSourceOpener,
        private readonly startExamForSources?: ProgressRecommendationExamStarter,
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
        this.recommendationSnapshot = null;
        this.controller.dispose();
        this.contentEl.empty();
        this.contentEl.removeClass("vault-coach-progress-workspace");
    }

    async refresh(): Promise<void> {
        if (this.disposed) return;
        const state = this.controller.getState();
        if (!state.available) {
            this.snapshot = null;
            this.recommendationSnapshot = null;
            this.loading = false;
            this.render();
            return;
        }

        const requestRevision = ++this.refreshRevision;
        this.loading = true;
        this.loadError = null;
        this.render();
        try {
            const [snapshot, recommendations] = await Promise.all([
                this.controller.getSnapshot(),
                this.application.recommendations.getSnapshot(),
            ]);
            if (this.isCurrentRequest(requestRevision)) {
                this.snapshot = snapshot;
                this.recommendationSnapshot = recommendations;
            }
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
            text: this.t("progress.recommendationsCount", { count: snapshot.recommendations.length }),
        });

        this.renderRecommendations(snapshot);

        const actions = this.contentEl.createDiv({ cls: "vault-coach-progress-dashboard-actions" });
        const openLearningMapButton = actions.createEl("button", {
            text: this.t("progress.openLearningMap"),
            attr: { type: "button" },
        });
        openLearningMapButton.addEventListener("click", () => { void this.openLearningMap(); });
    }

    private renderRecommendations(snapshot: ProgressSnapshot): void {
        const section = this.contentEl.createDiv({ cls: "vault-coach-progress-recommendations" });
        const header = section.createDiv({ cls: "vault-coach-progress-recommendations-header" });
        header.createEl("h3", { text: this.t("progress.recommendations.title") });
        const exportButton = header.createEl("button", {
            text: this.t("progress.recommendations.copyMarkdown"),
            attr: { type: "button" },
        });
        exportButton.addEventListener("click", () => { void this.copyRecommendationsMarkdown(exportButton); });

        section.createDiv({
            cls: "vault-coach-progress-workspace-muted",
            text: this.t("progress.recommendations.desc"),
        });
        if (snapshot.recommendations.length === 0) {
            section.createDiv({
                cls: "vault-coach-progress-workspace-muted",
                text: this.t("progress.recommendations.empty"),
            });
        } else {
            const list = section.createDiv({ cls: "vault-coach-progress-recommendation-list" });
            snapshot.recommendations.forEach((recommendation) => {
                const card = list.createDiv({ cls: "vault-coach-progress-recommendation" });
                card.createEl("strong", { text: recommendation.label });
                card.createDiv({
                    cls: "vault-coach-progress-workspace-muted",
                    text: recommendation.reasonCodes.map((reason) => this.reasonLabel(reason)).join(" · "),
                });
                if (recommendation.suggestedExamMode) {
                    card.createDiv({
                        cls: "vault-coach-progress-workspace-muted",
                        text: this.t("progress.recommendations.suggestedMode", {
                            mode: this.t(`exam.mode.${recommendation.suggestedExamMode}.title` as TranslationKey),
                        }),
                    });
                }
                const actions = card.createDiv({ cls: "vault-coach-progress-recommendation-actions" });
                this.createRecommendationSourceActions(actions, recommendation);
                this.createRecommendationAction(actions, recommendation.id, "completed", this.t("progress.recommendations.complete"));
                this.createRecommendationAction(actions, recommendation.id, "deferred", this.t("progress.recommendations.later"), Date.now() + 7 * 24 * 60 * 60 * 1000);
                this.createRecommendationAction(actions, recommendation.id, "dismissed", this.t("progress.recommendations.dismiss"));
            });
        }

        const actedOn = this.recommendationSnapshot?.queue.filter((item) => item.actionState !== "open") ?? [];
        if (actedOn.length > 0) {
            const history = section.createEl("details", { cls: "vault-coach-progress-recommendation-history" });
            history.createEl("summary", { text: this.t("progress.recommendations.actedOn", { count: actedOn.length }) });
            const list = history.createDiv({ cls: "vault-coach-progress-recommendation-list" });
            actedOn.forEach((recommendation) => {
                const row = list.createDiv({ cls: "vault-coach-progress-recommendation" });
                row.createEl("strong", { text: recommendation.label });
                row.createDiv({
                    cls: "vault-coach-progress-workspace-muted",
                    text: this.actionStateLabel(recommendation.actionState),
                });
                this.createRecommendationAction(
                    row.createDiv({ cls: "vault-coach-progress-recommendation-actions" }),
                    recommendation.id,
                    "restored",
                    this.t("progress.recommendations.restore"),
                );
            });
        }
    }

    private createRecommendationSourceActions(
        container: HTMLElement,
        recommendation: ProgressSnapshot["recommendations"][number],
    ): void {
        if (this.openRecommendationSources) {
            const openSource = container.createEl("button", {
                text: this.t("progress.recommendations.openSources"),
                attr: { type: "button" },
            });
            openSource.addEventListener("click", (event) => { void this.openRecommendationEvidence(openSource, recommendation.targetConceptIds, event); });
        }
        if (recommendation.suggestedAction === "practice-exam" && this.startExamForSources) {
            const exam = container.createEl("button", {
                text: this.t("progress.recommendations.startExam"),
                attr: { type: "button" },
            });
            exam.addEventListener("click", () => { void this.startRecommendationExam(exam, recommendation.targetConceptIds); });
        }
    }

    private async openRecommendationEvidence(
        button: HTMLButtonElement,
        conceptIds: readonly string[],
        event: MouseEvent,
    ): Promise<void> {
        if (!this.openRecommendationSources) return;
        button.disabled = true;
        try {
            const sourcePaths = await this.getRecommendationSourcePaths(conceptIds);
            if (sourcePaths.length === 1) {
                await this.openRecommendationSources(sourcePaths[0]!);
                return;
            }
            const menu = new Menu();
            sourcePaths.forEach((sourcePath) => menu.addItem((item) => item
                .setTitle(sourcePath)
                .onClick(() => void this.openRecommendationSources!(sourcePath).catch((error: unknown) => {
                    console.error("[ProgressWorkspaceView] 无法打开推荐的来源", error);
                    new Notice(this.t("progress.recommendations.sourceUnavailable"));
                }))));
            menu.showAtMouseEvent(event);
        } catch (error: unknown) {
            console.error("[ProgressWorkspaceView] 无法打开推荐的来源", error);
            new Notice(this.t("progress.recommendations.sourceUnavailable"));
        } finally {
            if (button.isConnected) button.disabled = false;
        }
    }

    private async startRecommendationExam(button: HTMLButtonElement, conceptIds: readonly string[]): Promise<void> {
        if (!this.startExamForSources) return;
        button.disabled = true;
        try {
            await this.startExamForSources(await this.getRecommendationSourcePaths(conceptIds));
        } catch (error: unknown) {
            console.error("[ProgressWorkspaceView] 无法启动推荐的范围考试", error);
            new Notice(this.t("progress.recommendations.examUnavailable"));
        } finally {
            if (button.isConnected) button.disabled = false;
        }
    }

    private async getRecommendationSourcePaths(conceptIds: readonly string[]): Promise<string[]> {
        const catalog = await this.application.learningGraph.getConceptCatalog();
        const selected = new Set(conceptIds);
        const paths = Array.from(new Set(catalog.concepts
            .filter((concept) => selected.has(concept.id))
            .flatMap((concept) => concept.sourcePaths)
            .filter((path) => path.length > 0)))
            .sort((left, right) => left.localeCompare(right));
        if (paths.length === 0) throw new Error("Recommendation has no current source path.");
        return paths;
    }

    private createRecommendationAction(
        container: HTMLElement,
        recommendationId: string,
        action: "completed" | "deferred" | "dismissed" | "restored",
        label: string,
        deferUntil?: number,
    ): void {
        const button = container.createEl("button", { text: label, attr: { type: "button" } });
        button.addEventListener("click", () => { void this.recordRecommendationAction(button, recommendationId, action, deferUntil); });
    }

    private async recordRecommendationAction(
        button: HTMLButtonElement,
        recommendationId: string,
        action: "completed" | "deferred" | "dismissed" | "restored",
        deferUntil?: number,
    ): Promise<void> {
        button.disabled = true;
        try {
            await this.application.recommendations.recordAction(recommendationId, action, deferUntil);
            await this.refresh();
        } catch (error: unknown) {
            console.error("[ProgressWorkspaceView] 无法保存复习建议操作", error);
            new Notice(this.t("progress.recommendations.actionFailed"));
            button.disabled = false;
        }
    }

    private async copyRecommendationsMarkdown(button: HTMLButtonElement): Promise<void> {
        button.disabled = true;
        try {
            const markdown = await this.application.recommendations.exportMarkdown();
            const clipboard = button.ownerDocument.defaultView?.navigator.clipboard;
            if (!clipboard?.writeText) throw new Error("Clipboard API is unavailable.");
            await clipboard.writeText(markdown);
            new Notice(this.t("progress.recommendations.copySuccess"));
        } catch (error: unknown) {
            console.error("[ProgressWorkspaceView] 无法复制学习计划 Markdown", error);
            new Notice(this.t("progress.recommendations.copyFailed"));
        } finally {
            if (button.isConnected) button.disabled = false;
        }
    }

    private reasonLabel(reason: ProgressSnapshot["recommendations"][number]["reasonCodes"][number]): string {
        const labels: Record<ProgressSnapshot["recommendations"][number]["reasonCodes"][number], TranslationKey> = {
            "weak-mastery": "progress.recommendations.reason.weakMastery",
            "developing-mastery": "progress.recommendations.reason.developingMastery",
            "review-due": "progress.recommendations.reason.reviewDue",
            "low-confidence": "progress.recommendations.reason.lowConfidence",
            unassessed: "progress.recommendations.reason.unassessed",
            "confirmed-prerequisite": "progress.recommendations.reason.confirmedPrerequisite",
            "high-connectivity": "progress.recommendations.reason.highConnectivity",
            "recently-covered": "progress.recommendations.reason.recentlyCovered",
        };
        return this.t(labels[reason]);
    }

    private actionStateLabel(actionState: RecommendationSnapshot["queue"][number]["actionState"]): string {
        if (actionState === "open") return "";
        const labels: Record<Exclude<RecommendationSnapshot["queue"][number]["actionState"], "open">, TranslationKey> = {
            dismissed: "progress.recommendations.state.dismissed",
            deferred: "progress.recommendations.state.deferred",
            completed: "progress.recommendations.state.completed",
        };
        return this.t(labels[actionState]);
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
