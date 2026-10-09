import { Modal, type App } from "obsidian";
import type { GraphCapacityAssessment } from "../../domain/graph-capacity/graph-capacity-types";
import { LITE_SEMANTIC_AUTO_WINDOW_LIMIT, LITE_SEMANTIC_MANUAL_WINDOW_LIMIT } from "../../domain/graph-capacity/graph-capacity-assessment";
import type { TranslationKey } from "../../i18n";

type Translate = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

interface CapacityModalOptions {
    title: string;
    description: string;
    continueLabel?: string;
    cancelLabel: string;
}

/**
 * 对成本较高但仍允许的本地构建获取用户明确确认；超过 Lite 窗口预算时，
 * 提供清晰的阻断原因。
 */
class SemanticGraphCapacityModal extends Modal {
    private settled = false;

    constructor(
        app: App,
        private readonly options: CapacityModalOptions,
        private readonly resolve: (continueBuild: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.setTitle(this.options.title);
        this.contentEl.createEl("p", { text: this.options.description });
        const actions = this.contentEl.createDiv({ cls: "vault-coach-confirm-actions" });
        const cancel = actions.createEl("button", { text: this.options.cancelLabel, attr: { type: "button" } });
        cancel.addEventListener("click", () => this.complete(false));
        if (!this.options.continueLabel) return;
        const continueButton = actions.createEl("button", {
            text: this.options.continueLabel,
            cls: "mod-warning",
            attr: { type: "button" },
        });
        continueButton.addEventListener("click", () => this.complete(true));
    }

    onClose(): void {
        this.contentEl.empty();
        if (this.settled) return;
        this.settled = true;
        this.resolve(false);
    }

    private complete(continueBuild: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve(continueBuild);
        this.close();
    }
}

/** 仅当手工语义重建可以在本地继续时返回 `true`。 */
export function requestSemanticGraphCapacityDecision(
    app: App,
    capacity: GraphCapacityAssessment,
    t: Translate,
): Promise<boolean> {
    const windowCount = capacity.reasons.find((reason) => reason.metric === "semantic-input-count")?.actual;
    if (windowCount === undefined && capacity.allowManualSemanticBuild) return Promise.resolve(true);

    if (!capacity.allowManualSemanticBuild) {
        return openCapacityModal(app, {
            title: t("semanticCapacity.blockedTitle"),
            description: t("semanticCapacity.blockedDescription", { count: windowCount ?? 0, limit: LITE_SEMANTIC_MANUAL_WINDOW_LIMIT }),
            cancelLabel: t("semanticCapacity.close"),
        });
    }

    if (windowCount !== undefined && windowCount > LITE_SEMANTIC_AUTO_WINDOW_LIMIT) {
        return openCapacityModal(app, {
            title: t("semanticCapacity.recommendTitle"),
            description: t("semanticCapacity.recommendDescription", { count: windowCount }),
            continueLabel: t("semanticCapacity.continueLocal"),
            cancelLabel: t("semanticCapacity.cancel"),
        });
    }
    return Promise.resolve(true);
}

function openCapacityModal(app: App, options: CapacityModalOptions): Promise<boolean> {
    return new Promise((resolve) => new SemanticGraphCapacityModal(app, options, resolve).open());
}
