import type { KnowledgeIndexBusyState } from "../../app/index/index-types";
import type { KnowledgeBaseStats } from "../../domain/documents/document-types";
import type { RetrievalMode, VectorIndexStats } from "../../domain/retrieval/retrieval-types";
import { translate, type TranslationKey } from "../../i18n";
import { ChatController } from "../controllers/chat-controller";
import type { VaultCoachPluginApi } from "../plugin-api";

export type VaultCoachInteractionMode = "qa" | "exam";

export interface VaultCoachHeaderState {
    activeMode: VaultCoachInteractionMode;
    interactionBusy: boolean;
    onModeChange(mode: VaultCoachInteractionMode): void;
    onResetConversation(): void;
    onRebuildIndex(): void;
    onClearIndex(): void;
    onAbortIndexBuild(): void;
}

/** Renders the stable top-level header shared by the Chat and Exam modes. */
export class VaultCoachHeader {
    constructor(
        private readonly plugin: VaultCoachPluginApi,
        private readonly chatController: ChatController,
    ) {}

    render(rootEl: HTMLDivElement, state: Readonly<VaultCoachHeaderState>): void {
        const headerEl = rootEl.createDiv({ cls: "vault-coach-header" });
        const headerTopEl = headerEl.createDiv({ cls: "vault-coach-header-top" });
        headerTopEl.createEl("h3", { text: this.plugin.settings.assistantName });
        this.renderModeSwitch(headerTopEl, state);

        const textStats = this.plugin.getKnowledgeBaseStats();
        const vectorStats = this.plugin.getVectorIndexStats();
        const indexBusyState = this.plugin.getKnowledgeIndexBusyState();
        const infoListEl = headerEl.createDiv({ cls: "vault-coach-header-info-grid" });

        this.renderStats(infoListEl, textStats, vectorStats, indexBusyState);
        if (indexBusyState.busy) {
            this.renderIndexBusyState(headerEl, indexBusyState, state.onAbortIndexBuild);
        }

        const toolbarEl = headerEl.createDiv({ cls: "vault-coach-toolbar" });
        if (state.activeMode === "qa") {
            this.renderQaToolbar(toolbarEl, indexBusyState.busy, state);
        }
        this.renderIndexActions(toolbarEl, indexBusyState.busy, state);
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    private renderStats(
        containerEl: HTMLDivElement,
        textStats: KnowledgeBaseStats,
        vectorStats: VectorIndexStats,
        indexBusyState: KnowledgeIndexBusyState,
    ): void {
        const sourceInventoryStatus = this.plugin.getSourceInventoryStatus();
        const textIndexStatusText = indexBusyState.busy && indexBusyState.phase === "vector"
            ? (textStats.lastIndexedAt ? this.t("view.indexStatus.ready") : this.t("view.indexStatus.building"))
            : indexBusyState.busy
                ? this.t("view.indexStatus.building")
                : sourceInventoryStatus === "possible-domain-switch"
                    ? this.t("view.indexStatus.domainSwitch")
                    : sourceInventoryStatus === "source-sync-required"
                        ? this.t("view.indexStatus.sourceSync")
                        : this.plugin.isTextIndexDirty()
                            ? this.t("view.indexStatus.dirty")
                            : (textStats.lastIndexedAt ? this.t("view.indexStatus.ready") : this.t("view.indexStatus.notBuilt"));
        const vectorIndexStatusText = indexBusyState.busy && indexBusyState.phase === "vector"
            ? this.t("view.indexStatus.building")
            : this.getVectorIndexStatusText(vectorStats);

        this.renderStat(containerEl, this.t("view.stat.knowledgeScope"), this.plugin.getLocalizedKnowledgeScopeDescription());
        this.renderStat(containerEl, this.t("view.stat.textIndex"), textIndexStatusText);
        this.renderStat(containerEl, this.t("view.stat.vectorIndex"), vectorIndexStatusText);
        this.renderStat(containerEl, this.t("view.stat.files"), String(textStats.fileCount));
        this.renderStat(containerEl, this.t("view.stat.chunks"), String(textStats.chunkCount));
        this.renderStat(containerEl, this.t("view.stat.memory"), this.t("view.stat.memoryValue", { count: this.plugin.getMemoryCount() }));
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

    private renderQaToolbar(
        toolbarEl: HTMLDivElement,
        indexBusy: boolean,
        state: Readonly<VaultCoachHeaderState>,
    ): void {
        const retrievalGroupEl = toolbarEl.createDiv({ cls: "vault-coach-retrieval-group" });
        retrievalGroupEl.createSpan({ text: `${this.t("view.retrievalModeLabel")} ` });
        const retrievalModeSelectEl = retrievalGroupEl.createEl("select");
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

        const resetButtonEl = toolbarEl.createEl("button", { text: this.t("view.resetConversation") });
        resetButtonEl.disabled = state.interactionBusy;
        resetButtonEl.addEventListener("click", state.onResetConversation);
    }

    private renderIndexActions(
        toolbarEl: HTMLDivElement,
        indexBusy: boolean,
        state: Readonly<VaultCoachHeaderState>,
    ): void {
        const rebuildButtonEl = toolbarEl.createEl("button", {
            text: indexBusy ? this.t("view.rebuildIndexBusy") : this.t("view.rebuildIndex"),
        });
        rebuildButtonEl.disabled = indexBusy || state.interactionBusy;
        rebuildButtonEl.addEventListener("click", state.onRebuildIndex);

        const clearIndexButtonEl = toolbarEl.createEl("button", {
            text: this.t("view.clearIndex"),
            cls: "vault-coach-danger-button",
            attr: { type: "button" },
        });
        clearIndexButtonEl.disabled = indexBusy || state.interactionBusy;
        clearIndexButtonEl.addEventListener("click", state.onClearIndex);
    }

    private renderModeSwitch(headerTopEl: HTMLDivElement, state: Readonly<VaultCoachHeaderState>): void {
        const modeSwitchEl = headerTopEl.createDiv({
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
        if (state.activeMode === mode) {
            buttonEl.addClass("is-active");
        }
        buttonEl.addEventListener("click", () => state.onModeChange(mode));
    }

    private renderStat(containerEl: HTMLDivElement, label: string, value: string): void {
        const itemEl = containerEl.createDiv({ cls: "vault-coach-header-stat" });
        itemEl.createDiv({ cls: "vault-coach-header-stat-label", text: label });
        itemEl.createDiv({ cls: "vault-coach-header-stat-value", text: value });
    }

    private addRetrievalOption(selectEl: HTMLSelectElement, value: RetrievalMode, label: string): void {
        const optionEl = selectEl.createEl("option");
        optionEl.value = value;
        optionEl.text = label;
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
