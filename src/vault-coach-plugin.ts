import { Notice, Plugin, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import {
    VIEW_TYPE_CONCEPT_REVIEW,
    VIEW_TYPE_LEARNING_MAP,
    VIEW_TYPE_PROGRESS,
    VIEW_TYPE_VAULT_COACH,
} from "./constants";
import { VaultCoachRuntime } from "./app/vault-coach-runtime";
import type { VaultCoachSettings } from "./app/config/settings-types";
import type { KnowledgeIndexBusyState } from "./app/index/index-types";
import type { KnowledgeBaseStats } from "./domain/documents/document-types";
import type { AnswerSource, RetrievalMode, VectorIndexStats } from "./domain/retrieval/retrieval-types";
import { getDefaultGreeting, isBuiltInDefaultGreeting, translate, type TranslationKey } from "./i18n";
import { registerVaultCoachCommands, registerVaultCoachRibbon } from "./plugin/command-registry";
import { activateMainWorkspaceView } from "./plugin/main-workspace-view";
import { LegacyPluginApiAdapter, type LegacyPluginApiHost } from "./presentation/legacy-plugin-api-adapter";
import { createDefaultSettings, DEFAULT_SETTINGS, VaultCoachSettingTab } from "./settings";
import { VaultCoachView } from "./presentation/vault-coach-view";
import { ConceptReviewView } from "./presentation/views/concept-review-view";
import { LearningMapView } from "./presentation/views/learning-map-view";
import { ProgressWorkspaceView } from "./presentation/views/progress-workspace-view";
import type { SourceInventoryStatus } from "./domain/index-lifecycle/source-inventory";
import { ConfirmActionModal } from "./presentation/modals/confirm-action-modal";
import { StorageFootprintModal } from "./presentation/modals/storage-footprint-modal";
import { requestSemanticGraphCapacityDecision } from "./presentation/modals/semantic-graph-capacity-modal";

/** Obsidian composition root: lifecycle, UI registration, and thin host adapters only. */
export default class VaultCoach extends Plugin implements LegacyPluginApiHost {
    settings: VaultCoachSettings = DEFAULT_SETTINGS;

    private runtime!: VaultCoachRuntime;
    private legacyApi!: LegacyPluginApiAdapter;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.runtime = new VaultCoachRuntime({
            app: this.app,
            pluginId: this.manifest.id,
            getSettings: () => this.settings,
            onStateChanged: () => this.refreshAllViews(),
            showNotice: (message, timeout) => new Notice(message, timeout),
            translate: (key, replacements) => this.t(key, replacements),
        });
        await this.runtime.initialize();
        this.legacyApi = new LegacyPluginApiAdapter(this.runtime.application, this);

        this.registerView(VIEW_TYPE_VAULT_COACH, (leaf: WorkspaceLeaf) => new VaultCoachView(
            leaf,
            this.runtime.application,
            this.legacyApi,
            () => this.activateProgressView(),
        ));
        this.registerView(VIEW_TYPE_CONCEPT_REVIEW, (leaf: WorkspaceLeaf) => new ConceptReviewView(leaf, this.runtime.application));
        this.registerView(VIEW_TYPE_LEARNING_MAP, (leaf: WorkspaceLeaf) => new LearningMapView(
            leaf,
            this.runtime.application,
            (filePath, heading) => this.openLearningMapSource(filePath, heading),
            (sourcePaths) => this.startLearningMapSourceExam(sourcePaths),
        ));
        this.registerView(VIEW_TYPE_PROGRESS, (leaf: WorkspaceLeaf) => new ProgressWorkspaceView(
            leaf,
            this.runtime.application,
            () => this.activateLearningMapView(),
            (sourcePath) => this.openLearningMapSource(sourcePath),
            (sourcePaths) => this.startLearningMapSourceExam(sourcePaths),
        ));
        registerVaultCoachCommands(this, this.legacyApi, (key, replacements) => this.t(key, replacements));
        this.registerSemanticGraphCommands();
        this.registerLearningDashboardEntry();
        registerVaultCoachRibbon(this, this.legacyApi, (key, replacements) => this.t(key, replacements));
        this.addSettingTab(new VaultCoachSettingTab(this.app, this, this.legacyApi));
        this.registerVaultEvents();

        this.app.workspace.onLayoutReady(() => {
            if (this.settings.openInRightSidebarOnStartup) void this.activateView();
        });
    }

    onunload(): void {
        void this.runtime?.dispose();
    }

    async loadSettings(): Promise<void> {
        const savedSettings = ((await this.loadData()) as Partial<VaultCoachSettings> | null) ?? {};
        this.settings = Object.assign({}, createDefaultSettings(), savedSettings);
        this.refreshBuiltInDefaultGreeting();
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    async activateView(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH)[0] ?? null;
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            if (!leaf) {
                new Notice(this.t("notice.cannotCreateView"));
                return;
            }
            await leaf.setViewState({ type: VIEW_TYPE_VAULT_COACH, active: true });
        }
        workspace.setActiveLeaf(leaf, { focus: true });
    }

    /** Opens Concept review in a normal workspace tab, never in the Ask/Exam sidebar. */
    async activateConceptReviewView(): Promise<void> {
        await activateMainWorkspaceView(this.app.workspace, VIEW_TYPE_CONCEPT_REVIEW);
    }

    /** Opens the read-only Learning Map in a normal workspace tab. */
    async activateLearningMapView(): Promise<void> {
        await activateMainWorkspaceView(this.app.workspace, VIEW_TYPE_LEARNING_MAP);
    }

    /** Opens the Progress dashboard in a normal workspace tab. */
    async activateProgressView(): Promise<void> {
        await activateMainWorkspaceView(this.app.workspace, VIEW_TYPE_PROGRESS);
    }

    refreshAllViews(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH)) {
            if (leaf.view instanceof VaultCoachView) leaf.view.refresh();
        }
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CONCEPT_REVIEW)) {
            if (leaf.view instanceof ConceptReviewView) void leaf.view.refresh();
        }
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LEARNING_MAP)) {
            if (leaf.view instanceof LearningMapView) void leaf.view.refresh();
        }
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PROGRESS)) {
            if (leaf.view instanceof ProgressWorkspaceView) void leaf.view.refresh();
        }
    }

    markKnowledgeBaseDirty(): void {
        this.runtime.markKnowledgeBaseDirty();
    }

    markVectorIndexDirty(): void {
        this.runtime.markVectorIndexDirty();
    }

    rebuildKnowledgeBase(showNotice: boolean, signal?: AbortSignal): Promise<void> {
        return this.runtime.rebuildKnowledgeBase(showNotice, signal);
    }

    clearKnowledgeIndex(showNotice: boolean): Promise<void> {
        return this.runtime.clearKnowledgeIndex(showNotice);
    }

    abortKnowledgeIndexBuild(showNotice: boolean): void {
        this.runtime.abortKnowledgeIndexBuild(showNotice);
    }

    isTextIndexDirty(): boolean {
        return this.runtime.isTextIndexDirty();
    }

    isVectorIndexDirty(): boolean {
        return this.runtime.isVectorIndexDirty();
    }

    getSourceInventoryStatus(): SourceInventoryStatus {
        return this.runtime.getSourceInventoryStatus();
    }

    getKnowledgeIndexBusyState(): KnowledgeIndexBusyState {
        return this.runtime.getKnowledgeIndexBusyState();
    }

    getKnowledgeBaseStats(): KnowledgeBaseStats {
        return this.runtime.getKnowledgeBaseStats();
    }

    getVectorIndexStats(): VectorIndexStats {
        return this.runtime.getVectorIndexStats();
    }

    getLocalizedKnowledgeScopeDescription(): string {
        return this.runtime.getLocalizedKnowledgeScopeDescription();
    }

    getEffectiveDefaultGreeting(): string {
        return this.runtime.getEffectiveDefaultGreeting();
    }

    getRuntimeRetrievalMode(): RetrievalMode {
        return this.runtime.getRuntimeRetrievalMode();
    }

    setRuntimeRetrievalMode(mode: RetrievalMode): void {
        this.runtime.setRuntimeRetrievalMode(mode);
    }

    getActiveChatModelName(): string {
        return this.runtime.getActiveChatModelName();
    }

    getActiveEmbeddingModelName(): string {
        return this.runtime.getActiveEmbeddingModelName();
    }

    getMemoryCount(): number {
        return this.runtime.getMemoryCount();
    }

    async openSource(source: AnswerSource): Promise<void> {
        const activeFilePath = this.app.workspace.getActiveFile()?.path ?? "";
        const linkTarget = source.locator?.type === "pdf"
            ? `${source.filePath}#page=${source.locator.pageStart}`
            : source.heading ? `${source.filePath}#${source.heading}` : source.filePath;
        await this.app.workspace.openLinkText(linkTarget, activeFilePath, false);
    }

    private async openLearningMapSource(filePath: string, heading?: string): Promise<void> {
        const activeFilePath = this.app.workspace.getActiveFile()?.path ?? "";
        await this.app.workspace.openLinkText(heading ? `${filePath}#${heading}` : filePath, activeFilePath, false);
    }

    /** Bridges a Learning Map concept to the existing, user-editable Exam setup. */
    private async startLearningMapSourceExam(sourcePaths: readonly string[]): Promise<void> {
        await this.activateView();
        const coachView = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH)
            .map((leaf) => leaf.view)
            .find((view): view is VaultCoachView => view instanceof VaultCoachView);
        if (!coachView?.openSourceScopedExam(sourcePaths)) {
            new Notice(this.t("learningMap.sourceExamUnavailable"));
        }
    }

    private registerVaultEvents(): void {
        this.registerEvent(this.app.vault.on("create", (file: TAbstractFile) => this.runtime.handleVaultPathChanged(file.path)));
        this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => this.runtime.handleVaultPathChanged(file.path)));
        this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => this.runtime.handleVaultPathChanged(file.path)));
        this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
            this.runtime.handleVaultPathRenamed(oldPath, file.path);
        }));
    }

    private registerSemanticGraphCommands(): void {
        this.addCommand({
            id: "open-concept-review",
            name: this.t("command.openConceptReview"),
            callback: async () => this.activateConceptReviewView(),
        });
        this.addCommand({
            id: "open-learning-map",
            name: this.t("command.openLearningMap"),
            callback: async () => this.activateLearningMapView(),
        });
        this.addCommand({
            id: "rebuild-semantic-concept-graph",
            name: this.t("command.rebuildSemanticGraph"),
            callback: async () => {
                if (this.runtime.application.semanticGraph.getState().busy) {
                    new Notice(this.t("semantic.building"));
                    return;
                }
                const capacity = this.runtime.application.semanticGraph.getState().capacity;
                if (!await requestSemanticGraphCapacityDecision(this.app, capacity, (key, replacements) => this.t(key, replacements))) {
                    return;
                }
                try {
                    await this.runtime.application.semanticGraph.rebuild();
                    new Notice(this.t("notice.semanticGraphUpdated"));
                    this.refreshAllViews();
                } catch (error: unknown) {
                    const message = error instanceof Error && error.message.trim().length > 0
                        ? error.message
                        : this.t("notice.semanticGraphBuildFailed");
                    new Notice(message, 10_000);
                }
            },
        });
        this.addCommand({
            id: "reset-semantic-governance-decisions",
            name: this.t("command.resetSemanticGovernance"),
            callback: () => {
                const impact = this.runtime.application.semanticGraph.getGovernanceImpact();
                new ConfirmActionModal(this.app, {
                    title: this.t("semanticGovernance.resetTitle"),
                    description: this.t("semanticGovernance.resetDescription", {
                        decisions: impact.decisionCount,
                        affectedConceptCount: impact.affectedConceptCount,
                    }),
                    confirmLabel: this.t("semanticGovernance.resetConfirm"),
                    cancelLabel: this.t("semanticGovernance.cancel"),
                    onConfirm: async () => {
                        try {
                            await this.runtime.application.semanticGraph.resetGovernanceDecisions();
                            new Notice(this.t("notice.semanticGovernanceReset"));
                            this.refreshAllViews();
                        } catch {
                            new Notice(this.t("notice.semanticGovernanceResetFailed"));
                            throw new Error("Semantic governance reset failed.");
                        }
                    },
                }).open();
            },
        });
        this.addCommand({
            id: "show-derived-storage-footprint",
            name: this.t("command.showStorageFootprint"),
            callback: () => new StorageFootprintModal(this.app, {
                getFootprint: () => this.runtime.application.index.getStorageFootprint(),
                t: (key, replacements) => this.t(key, replacements),
            }).open(),
        });
        this.addCommand({
            id: "rebuild-concept-mastery",
            name: this.t("command.rebuildConceptMastery"),
            callback: async () => {
                try {
                    const snapshot = await this.runtime.application.mastery.rebuild();
                    new Notice(this.t("notice.conceptMasteryUpdated", { count: snapshot.states.length }));
                    this.refreshAllViews();
                } catch {
                    new Notice(this.t("notice.conceptMasteryBuildFailed"));
                }
            },
        });
    }

    private registerLearningDashboardEntry(): void {
        this.addCommand({
            id: "open-learning-dashboard",
            name: this.t("command.openLearningDashboard"),
            callback: async () => this.activateProgressView(),
        });
        this.addRibbonIcon("chart-line", this.t("ribbon.openLearningDashboard"), () => {
            void this.activateProgressView();
        });
    }

    private refreshBuiltInDefaultGreeting(): void {
        if (this.settings.defaultGreeting.trim().length === 0 || isBuiltInDefaultGreeting(this.settings.defaultGreeting)) {
            this.settings.defaultGreeting = getDefaultGreeting();
        }
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }
}
