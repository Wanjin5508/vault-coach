import type { ProgressViewState } from "../controllers/progress-controller";
import { translate } from "../../i18n";

/**
 * Compact sidebar launcher for the main-workspace Learning dashboard.
 *
 * The sidebar remains a focused Ask/Practice surface: it contains no dashboard
 * metrics or graph renderer, only a lightweight route to the workspace View.
 */
export class ProgressView {
    constructor(private readonly openWorkspace: () => Promise<void>) {}

    render(rootEl: HTMLDivElement, _state: Readonly<ProgressViewState>): void {
        const entry = rootEl.createDiv({ cls: "vault-coach-progress-entry" });
        entry.createSpan({ cls: "vault-coach-progress-entry-title", text: translate("progress.title") });
        const openButton = entry.createEl("button", {
            cls: "vault-coach-progress-entry-button",
            text: translate("progress.sidebar.open"),
            attr: { type: "button", "aria-label": translate("command.openLearningDashboard") },
        });
        openButton.addEventListener("click", () => {
            void this.openWorkspace();
        });
    }

    dispose(): void {
        // The launcher owns no subscription or DOM outside the parent View.
    }
}
