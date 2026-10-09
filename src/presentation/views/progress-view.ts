import type { ProgressViewState } from "../controllers/progress-controller";
import { translate } from "../../i18n";

/**
 * 主工作区 Learning Dashboard 的紧凑侧边栏入口。
 *
 * 侧边栏继续专注于 Ask/Practice，不包含 Dashboard 指标或图渲染器，
 * 只提供进入工作区 View 的轻量导航。
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
        // 入口组件不持有父 View 之外的订阅或 DOM。
    }
}
