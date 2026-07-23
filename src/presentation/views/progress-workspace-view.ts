import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { VaultCoachApplicationApi } from "../../app/application-api";
import { VIEW_NAME_PROGRESS, VIEW_TYPE_PROGRESS } from "../../constants";
import { ProgressController } from "../controllers/progress-controller";

export type LearningMapWorkspaceOpener = () => Promise<void>;

/**
 * Main-workspace shell for the Learning dashboard.
 *
 * L5.3 deliberately owns only the ItemView lifecycle and workspace entry. The
 * L5.4 Dashboard will render ProgressSnapshot summaries here; no snapshot is
 * read while this shell opens, keeping the new entry lightweight.
 */
export class ProgressWorkspaceView extends ItemView {
    private readonly controller: ProgressController;
    private disposed = false;

    constructor(
        leaf: WorkspaceLeaf,
        application: VaultCoachApplicationApi,
        private readonly openLearningMap: LearningMapWorkspaceOpener,
    ) {
        super(leaf);
        this.controller = new ProgressController(application.progress);
    }

    getViewType(): string { return VIEW_TYPE_PROGRESS; }
    getDisplayText(): string { return VIEW_NAME_PROGRESS; }
    getIcon(): string { return "chart-line"; }

    async onOpen(): Promise<void> {
        this.render();
    }

    async onClose(): Promise<void> {
        this.disposed = true;
        this.controller.dispose();
        this.contentEl.empty();
        this.contentEl.removeClass("vault-coach-progress-workspace");
    }

    refresh(): void {
        if (!this.disposed) this.render();
    }

    private render(): void {
        this.contentEl.empty();
        this.contentEl.addClass("vault-coach-progress-workspace");

        const header = this.contentEl.createDiv({ cls: "vault-coach-progress-workspace-header" });
        header.createEl("h2", { text: VIEW_NAME_PROGRESS });
        header.createDiv({
            cls: "vault-coach-progress-workspace-summary",
            text: "Review local learning evidence and explore confirmed knowledge relationships.",
        });

        const state = this.controller.getState();
        if (!state.available) {
            this.contentEl.createDiv({
                cls: "vault-coach-progress-workspace-message is-error",
                text: "Learning dashboard data is unavailable for this vault.",
            });
            return;
        }

        const message = this.contentEl.createDiv({ cls: "vault-coach-progress-workspace-message" });
        message.createDiv({ text: "The dashboard is ready to show your local learning progress." });
        message.createDiv({
            cls: "vault-coach-progress-workspace-muted",
            text: "Open Learning map to inspect confirmed concepts and relationship direction.",
        });
        const openLearningMapButton = message.createEl("button", {
            text: "Open learning map",
            attr: { type: "button" },
        });
        openLearningMapButton.addEventListener("click", () => {
            void this.openLearningMap();
        });
    }
}
