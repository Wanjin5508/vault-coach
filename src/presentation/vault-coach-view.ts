import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { VaultCoachApplicationApi } from "../app/application-api";
import { VIEW_NAME_VAULT_COACH, VIEW_TYPE_VAULT_COACH } from "../constants";
import { translate, type TranslationKey } from "../i18n";
import { createShortErrorMessage } from "../ui/view-formatters";
import { VaultCoachHeader, type VaultCoachInteractionMode } from "./components/vault-coach-header";
import { ChatController, type ChatControllerEvent } from "./controllers/chat-controller";
import { ExamController, type ExamControllerEvent } from "./controllers/exam-controller";
import { ProgressController } from "./controllers/progress-controller";
import type { VaultCoachPluginApi } from "./plugin-api";
import { ChatView } from "./views/chat-view";
import { ExamView } from "./views/exam-view";
import { ProgressView } from "./views/progress-view";

/**
 * Obsidian ItemView shell for VaultCoach.
 *
 * Business interactions are owned by feature controllers; this class only owns
 * the sidebar lifecycle, the top-level mode switch, and cross-feature refresh.
 */
export class VaultCoachView extends ItemView {
    private readonly chatController: ChatController;
    private readonly chatView: ChatView;
    private readonly unsubscribeChatController: () => void;
    private readonly examController: ExamController;
    private readonly examView: ExamView;
    private readonly unsubscribeExamController: () => void;
    private readonly progressController: ProgressController;
    private readonly progressView: ProgressView;
    private readonly header: VaultCoachHeader;
    private hasDeferredRefresh = false;
    private indexActionInFlight = false;
    private activeInteractionMode: VaultCoachInteractionMode = "qa";
    private postOpenStyleRefreshTimers: number[] = [];

    constructor(
        leaf: WorkspaceLeaf,
        private readonly application: VaultCoachApplicationApi,
        private readonly plugin: VaultCoachPluginApi,
        openProgressWorkspace: () => Promise<void>,
    ) {
        super(leaf);
        this.chatController = new ChatController(plugin, () => this.contentEl.win);
        this.chatView = new ChatView(this.app, this, this.chatController);
        this.unsubscribeChatController = this.chatController.subscribe((event) => this.handleChatControllerEvent(event));
        this.examController = new ExamController(plugin, (key, replacements) => this.t(key, replacements));
        this.examView = new ExamView(this.app, this, this.examController);
        this.unsubscribeExamController = this.examController.subscribe((event) => this.handleExamControllerEvent(event));
        this.progressController = new ProgressController(application.progress);
        this.progressView = new ProgressView(openProgressWorkspace);
        this.header = new VaultCoachHeader(plugin, this.chatController);
    }

    getViewType(): string {
        return VIEW_TYPE_VAULT_COACH;
    }

    getDisplayText(): string {
        return VIEW_NAME_VAULT_COACH;
    }

    getIcon(): string {
        return "message-square";
    }

    async onOpen(): Promise<void> {
        await Promise.resolve();
        this.render();
        this.schedulePostOpenStyleRefresh();
    }

    async onClose(): Promise<void> {
        await Promise.resolve();
        this.clearPostOpenStyleRefreshTimers();
        this.chatView.dispose();
        this.unsubscribeChatController();
        this.chatController.dispose();
        this.examView.dispose();
        this.unsubscribeExamController();
        this.examController.dispose();
        this.progressView.dispose();
        this.progressController.dispose();
        this.contentEl.empty();
        this.contentEl.removeClass("vault-coach-view");
    }

    /** Refreshes the sidebar without interrupting an active Chat or Exam action. */
    refresh(): void {
        if (this.isInteractionBusy()) {
            this.hasDeferredRefresh = true;
            return;
        }
        this.hasDeferredRefresh = false;
        this.render();
    }

    private t(key: TranslationKey, replacements?: Record<string, string | number>): string {
        return translate(key, replacements);
    }

    private isInteractionBusy(): boolean {
        return this.indexActionInFlight || this.chatController.getState().busy || this.examController.getState().busy;
    }

    private handleChatControllerEvent(event: ChatControllerEvent): void {
        if (event.type === "busy-changed" && !event.busy && this.hasDeferredRefresh) {
            this.refresh();
        }
    }

    private handleExamControllerEvent(event: ExamControllerEvent): void {
        if (event.type === "notice") {
            const replacements = event.error === undefined
                ? event.replacements
                : { ...event.replacements, message: createShortErrorMessage(event.error) };
            new Notice(this.t(event.key, replacements));
            return;
        }
        if (this.activeInteractionMode === "exam") {
            this.examView.preserveScrollPosition();
            this.render();
        }
    }

    private render(): void {
        this.hasDeferredRefresh = false;
        this.contentEl.empty();
        this.contentEl.addClass("vault-coach-view");

        const rootEl = this.contentEl.createDiv({ cls: "vault-coach-root" });
        this.header.render(rootEl, {
            activeMode: this.activeInteractionMode,
            interactionBusy: this.isInteractionBusy(),
            onModeChange: (mode) => this.switchMode(mode),
            onResetConversation: () => this.resetConversation(),
            onRebuildIndex: () => { void this.handleRebuildIndex(); },
            onClearIndex: () => { void this.handleClearIndex(); },
            onAbortIndexBuild: () => this.plugin.abortKnowledgeIndexBuild(true),
        });

        if (this.progressController.isAvailable()) {
            this.progressView.render(rootEl, this.progressController.getState());
        }
        if (this.activeInteractionMode === "exam") {
            this.chatView.detach();
            this.examView.render(rootEl);
            return;
        }
        this.chatView.render(rootEl);
    }

    private switchMode(mode: VaultCoachInteractionMode): void {
        if (this.activeInteractionMode === mode) {
            return;
        }
        this.activeInteractionMode = mode;
        this.render();
    }

    private resetConversation(): void {
        this.chatController.resetConversation();
        this.chatView.focusInput();
    }

    private async handleRebuildIndex(): Promise<void> {
        if (this.isInteractionBusy() || this.plugin.getKnowledgeIndexBusyState().busy) {
            return;
        }

        this.indexActionInFlight = true;
        try {
            await this.plugin.rebuildKnowledgeBase(true);
        } finally {
            this.indexActionInFlight = false;
            this.refresh();
            if (this.activeInteractionMode === "qa") {
                this.chatView.focusInput();
            }
        }
    }

    private async handleClearIndex(): Promise<void> {
        if (this.isInteractionBusy() || this.plugin.getKnowledgeIndexBusyState().busy) {
            return;
        }
        await this.plugin.clearKnowledgeIndex(true);
    }

    private schedulePostOpenStyleRefresh(): void {
        this.clearPostOpenStyleRefreshTimers();
        for (const delayMs of [50, 250, 750]) {
            const timerId = window.setTimeout(() => {
                this.postOpenStyleRefreshTimers = this.postOpenStyleRefreshTimers.filter((id) => id !== timerId);
                this.refreshInitialLayoutIfStylesReady();
            }, delayMs);
            this.postOpenStyleRefreshTimers.push(timerId);
        }
    }

    private clearPostOpenStyleRefreshTimers(): void {
        for (const timerId of this.postOpenStyleRefreshTimers) {
            window.clearTimeout(timerId);
        }
        this.postOpenStyleRefreshTimers = [];
    }

    private refreshInitialLayoutIfStylesReady(): void {
        if (!this.isVaultCoachStylesheetActive()) {
            return;
        }
        this.clearPostOpenStyleRefreshTimers();
        if (this.isInteractionBusy() || this.chatView.hasInputText()) {
            return;
        }
        this.render();
    }

    private isVaultCoachStylesheetActive(): boolean {
        const sentinelEl = this.contentEl.createDiv({ cls: "vault-coach-style-sentinel" });
        const loadedValue = getComputedStyle(sentinelEl)
            .getPropertyValue("--vault-coach-style-loaded")
            .trim();
        sentinelEl.remove();
        return loadedValue === "1";
    }
}
