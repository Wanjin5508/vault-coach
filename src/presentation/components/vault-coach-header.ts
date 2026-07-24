import { setIcon } from "obsidian";
import type { KnowledgeIndexBusyState } from "../../app/index/index-types";
import type { KnowledgeBaseStats } from "../../domain/documents/document-types";
import type { RetrievalMode, VectorIndexStats } from "../../domain/retrieval/retrieval-types";
import { translate, type TranslationKey } from "../../i18n";
import { ChatController } from "../controllers/chat-controller";
import type { VaultCoachPluginApi } from "../plugin-api";

export type VaultCoachInteractionMode = "qa" | "exam";
type HeaderPanel = "info" | "options" | null;

export interface VaultCoachHeaderState {
    activeMode: VaultCoachInteractionMode;
    interactionBusy: boolean;
    onModeChange(mode: VaultCoachInteractionMode): void;
    onResetConversation(): void;
    onRebuildIndex(): void;
    onClearIndex(): void;
    onAbortIndexBuild(): void;
}

/**
 * A compact, popover-based top-level header shared by the Ask and Exam modes.
 * The study surface stays visible by default; diagnostics and destructive
 * index actions are intentionally one click away.
 */
export class VaultCoachHeader {
    private openPanel: HeaderPanel = null;

    constructor(
        private readonly plugin: VaultCoachPluginApi,
        private readonly chatController: ChatController,
    ) {}

    render(rootEl: HTMLDivElement, state: Readonly<VaultCoachHeaderState>): void {
        const headerEl = rootEl.createDiv({ cls: "vault-coach-header" });
        const headerTopEl = headerEl.createDiv({ cls: "vault-coach-header-top" });
        const titleAndModeEl = headerTopEl.createDiv({ cls: "vault-coach-header-title-and-mode" });
        titleAndModeEl.createEl("h3", { text: this.plugin.settings.assistantName });
        this.renderModeSwitch(titleAndModeEl, state);
        this.renderScope(headerTopEl);

        const textStats = this.plugin.getKnowledgeBaseStats();
        const vectorStats = this.plugin.getVectorIndexStats();
        const indexBusyState = this.plugin.getKnowledgeIndexBusyState();
        const infoPanel = headerEl.createDiv({ cls: "vault-coach-header-popover vault-coach-header-info-popover" });
        const optionsPanel = headerEl.createDiv({ cls: "vault-coach-header-popover vault-coach-header-options-popover" });
        this.renderInfoPanel(infoPanel, textStats, vectorStats, indexBusyState);
        this.renderOptionsPanel(optionsPanel, indexBusyState.busy, state);

        const actionsEl = headerTopEl.createDiv({ cls: "vault-coach-header-icon-actions" });
        const sourceStatus = this.plugin.getSourceInventoryStatus();
        const infoButton = this.createIconButton(
            actionsEl,
            "info",
            this.t("view.header.info"),
            sourceStatus === "source-sync-required" || sourceStatus === "possible-domain-switch",
        );
        const optionsButton = this.createIconButton(actionsEl, "settings", this.t("view.header.options"));
        this.syncPanelVisibility(infoPanel, optionsPanel, infoButton, optionsButton);
        infoButton.addEventListener("click", () => {
            this.openPanel = this.openPanel === "info" ? null : "info";
            this.syncPanelVisibility(infoPanel, optionsPanel, infoButton, optionsButton);
        });
        optionsButton.addEventListener("click", () => {
            this.openPanel = this.openPanel === "options" ? null : "options";
            this.syncPanelVisibility(infoPanel, optionsPanel, infoButton, optionsButton);
        });

        if (indexBusyState.busy) {
            this.renderIndexBusyState(headerEl, indexBusyState, state.onAbortIndexBuild);
        }
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    private renderScope(containerEl: HTMLDivElement): void {
        const scopeEl = containerEl.createDiv({
            cls: "vault-coach-header-scope",
            attr: { title: this.plugin.getLocalizedKnowledgeScopeDescription() },
        });
        scopeEl.createSpan({ cls: "vault-coach-header-scope-label", text: this.t("view.stat.knowledgeScope") });
        scopeEl.createSpan({ cls: "vault-coach-header-scope-value", text: this.plugin.getLocalizedKnowledgeScopeDescription() });
    }

    private renderInfoPanel(
        panelEl: HTMLDivElement,
        textStats: KnowledgeBaseStats,
        vectorStats: VectorIndexStats,
        indexBusyState: KnowledgeIndexBusyState,
    ): void {
        panelEl.createDiv({ cls: "vault-coach-header-popover-title", text: this.t("view.header.info") });
        const infoListEl = panelEl.createDiv({ cls: "vault-coach-header-info-grid" });
        this.renderStat(infoListEl, this.t("view.stat.textIndex"), this.getTextIndexStatusText(textStats, indexBusyState));
        this.renderStat(infoListEl, this.t("view.stat.vectorIndex"), this.getVectorIndexStatusText(vectorStats));
        this.renderStat(infoListEl, this.t("view.stat.files"), String(textStats.fileCount));
        this.renderStat(infoListEl, this.t("view.stat.chunks"), String(textStats.chunkCount));
        this.renderStat(infoListEl, this.t("view.stat.memory"), this.t("view.stat.memoryValue", { count: this.plugin.getMemoryCount() }));
    }

    private renderOptionsPanel(
        panelEl: HTMLDivElement,
        indexBusy: boolean,
        state: Readonly<VaultCoachHeaderState>,
    ): void {
        panelEl.createDiv({ cls: "vault-coach-header-popover-title", text: this.t("view.header.options") });
        if (state.activeMode === "qa") this.renderQaOptions(panelEl, indexBusy, state);
        this.renderIndexActions(panelEl, indexBusy, state);
    }

    private renderIndexBusyState(
        containerEl: HTMLDivElement,
        state: KnowledgeIndexBusyState,
        onAbortIndexBuild: () => void,
    ): void {
        const busyEl = containerEl.createDiv({
            cls: "vault-coach-index-busy",
            attr: { "aria-live": "polite", role: "status" },
        });
        busyEl.createSpan({ cls: "vault-coach-thinking-spinner vault-coach-index-busy-spinner" });
        busyEl.createSpan({ cls: "vault-coach-index-busy-text", text: this.getIndexBusyText(state) });
        const stopButtonEl = busyEl.createEl("button", {
            text: this.t("view.stopIndexBuild"),
            cls: "vault-coach-danger-button vault-coach-index-stop-button",
            attr: { type: "button" },
        });
        stopButtonEl.addEventListener("click", onAbortIndexBuild);
    }

    private renderQaOptions(
        panelEl: HTMLDivElement,
        indexBusy: boolean,
        state: Readonly<VaultCoachHeaderState>,
    ): void {
        const retrievalGroupEl = panelEl.createDiv({ cls: "vault-coach-retrieval-group" });
        retrievalGroupEl.createSpan({ text: this.t("view.retrievalModeLabel") });
        const retrievalModeSelectEl = retrievalGroupEl.createEl("select", {
            attr: { "aria-label": this.t("view.retrievalModeLabel") },
        });
        this.addRetrievalOption(retrievalModeSelectEl, "keyword", this.t("view.retrieval.keyword"));
        this.addRetrievalOption(retrievalModeSelectEl, "vector", this.t("view.retrieval.vector"));
        this.addRetrievalOption(retrievalModeSelectEl, "hybrid", this.t("view.retrieval.hybrid"));
        retrievalModeSelectEl.value = this.chatController.getRetrievalMode();
        retrievalModeSelectEl.disabled = state.interactionBusy || indexBusy;
        retrievalModeSelectEl.addEventListener("change", () => {
            const value = retrievalModeSelectEl.value;
            if (value === "keyword" || value === "vector" || value === "hybrid") {
                this.chatController.setRetrievalMode(value);
            }
        });

        const resetButtonEl = panelEl.createEl("button", {
            text: this.t("view.resetConversation"),
            attr: { type: "button" },
        });
        resetButtonEl.disabled = state.interactionBusy;
        resetButtonEl.addEventListener("click", () => {
            this.closePanel(panelEl);
            state.onResetConversation();
        });
    }

    private renderIndexActions(
        panelEl: HTMLDivElement,
        indexBusy: boolean,
        state: Readonly<VaultCoachHeaderState>,
    ): void {
        const actionGroupEl = panelEl.createDiv({ cls: "vault-coach-header-index-actions" });
        const rebuildButtonEl = actionGroupEl.createEl("button", {
            text: indexBusy ? this.t("view.rebuildIndexBusy") : this.t("view.rebuildIndex"),
            attr: { type: "button" },
        });
        rebuildButtonEl.disabled = indexBusy || state.interactionBusy;
        rebuildButtonEl.addEventListener("click", () => {
            this.closePanel(panelEl);
            state.onRebuildIndex();
        });

        const clearIndexButtonEl = actionGroupEl.createEl("button", {
            text: this.t("view.clearIndex"),
            cls: "vault-coach-danger-button",
            attr: { type: "button" },
        });
        clearIndexButtonEl.disabled = indexBusy || state.interactionBusy;
        clearIndexButtonEl.addEventListener("click", () => {
            this.closePanel(panelEl);
            state.onClearIndex();
        });
    }

    private renderModeSwitch(containerEl: HTMLDivElement, state: Readonly<VaultCoachHeaderState>): void {
        const modeSwitchEl = containerEl.createDiv({
            cls: "vault-coach-mode-switch",
            attr: { role: "group", "aria-label": this.t("view.modeLabel") },
        });
        this.renderModeOption(modeSwitchEl, "qa", this.t("view.mode.qa"), state);
        this.renderModeOption(modeSwitchEl, "exam", this.t("view.mode.exam"), state);
    }

    private renderModeOption(
        containerEl: HTMLDivElement,
        mode: VaultCoachInteractionMode,
        label: string,
        state: Readonly<VaultCoachHeaderState>,
    ): void {
        const buttonEl = containerEl.createEl("button", {
            text: label,
            cls: "vault-coach-mode-option",
            attr: {
                type: "button",
                "data-mode": mode,
                "aria-pressed": String(state.activeMode === mode),
            },
        });
        if (state.activeMode === mode) buttonEl.addClass("is-active");
        buttonEl.addEventListener("click", () => {
            this.openPanel = null;
            state.onModeChange(mode);
        });
    }

    private renderStat(containerEl: HTMLDivElement, label: string, value: string): void {
        const itemEl = containerEl.createDiv({ cls: "vault-coach-header-stat" });
        itemEl.createDiv({ cls: "vault-coach-header-stat-label", text: label });
        itemEl.createDiv({ cls: "vault-coach-header-stat-value", text: value });
    }

    private createIconButton(
        containerEl: HTMLDivElement,
        icon: "info" | "settings",
        label: string,
        attention = false,
    ): HTMLButtonElement {
        const button = containerEl.createEl("button", {
            cls: "vault-coach-header-icon-button",
            attr: { type: "button", "aria-label": label, title: label, "aria-expanded": "false" },
        });
        if (attention) button.addClass("is-attention");
        setIcon(button, icon);
        return button;
    }

    private syncPanelVisibility(
        infoPanel: HTMLDivElement,
        optionsPanel: HTMLDivElement,
        infoButton: HTMLButtonElement,
        optionsButton: HTMLButtonElement,
    ): void {
        const infoOpen = this.openPanel === "info";
        const optionsOpen = this.openPanel === "options";
        infoPanel.toggleClass("is-open", infoOpen);
        optionsPanel.toggleClass("is-open", optionsOpen);
        infoButton.setAttribute("aria-expanded", String(infoOpen));
        optionsButton.setAttribute("aria-expanded", String(optionsOpen));
    }

    private closePanel(panelEl: HTMLDivElement): void {
        this.openPanel = null;
        panelEl.removeClass("is-open");
        panelEl
            .closest(".vault-coach-header")
            ?.querySelector<HTMLButtonElement>(
                '.vault-coach-header-icon-button[aria-expanded="true"]',
            )
            ?.setAttribute("aria-expanded", "false");
    }

    private addRetrievalOption(selectEl: HTMLSelectElement, value: RetrievalMode, label: string): void {
        const optionEl = selectEl.createEl("option");
        optionEl.value = value;
        optionEl.text = label;
    }

    private getTextIndexStatusText(textStats: KnowledgeBaseStats, indexBusyState: KnowledgeIndexBusyState): string {
        const sourceInventoryStatus = this.plugin.getSourceInventoryStatus();
        if (indexBusyState.busy && indexBusyState.phase === "vector") {
            return textStats.lastIndexedAt ? this.t("view.indexStatus.ready") : this.t("view.indexStatus.building");
        }
        if (indexBusyState.busy) return this.t("view.indexStatus.building");
        if (sourceInventoryStatus === "possible-domain-switch") return this.t("view.indexStatus.domainSwitch");
        if (sourceInventoryStatus === "source-sync-required") return this.t("view.indexStatus.sourceSync");
        if (this.plugin.isTextIndexDirty()) return this.t("view.indexStatus.dirty");
        return textStats.lastIndexedAt ? this.t("view.indexStatus.ready") : this.t("view.indexStatus.notBuilt");
    }

    private getIndexBusyText(state: KnowledgeIndexBusyState): string {
        if (state.phase === "rebuilding") return this.t("view.indexBusy.rebuilding");
        if (state.phase === "syncing") return this.t("view.indexBusy.syncing");
        if (state.phase === "vector") return this.t("view.indexBusy.vector");
        return this.t("view.indexBusy.generic");
    }

    private getVectorIndexStatusText(vectorStats: VectorIndexStats): string {
        if (!this.plugin.settings.enableVectorRetrieval) return this.t("view.indexStatus.vectorDisabled");
        if (this.plugin.isVectorIndexDirty()) return this.t("view.indexStatus.dirty");
        return vectorStats.ready
            ? this.t("view.indexStatus.vectorReady", { count: vectorStats.vectorCount })
            : this.t("view.indexStatus.vectorFallback");
    }
}
