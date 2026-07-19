import type { TranslationKey } from "../../i18n";

export type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/** Renders the shared assistant-thinking indicator without owning interaction state. */
export function renderThinkingIndicator(containerEl: HTMLDivElement, t: TranslateFn): void {
    containerEl.empty();
    containerEl.addClass("vault-coach-thinking-bubble");

    const thinkingEl: HTMLDivElement = containerEl.createDiv({
        cls: "vault-coach-thinking-indicator",
    });

    thinkingEl.createSpan({
        cls: "vault-coach-thinking-spinner",
        attr: {
            "aria-hidden": "true",
        },
    });

    thinkingEl.createSpan({
        cls: "vault-coach-thinking-text",
        text: t("view.thinking"),
    });

    const dotsEl: HTMLSpanElement = thinkingEl.createSpan({
        cls: "vault-coach-thinking-dots",
        attr: {
            "aria-hidden": "true",
        },
    });

    for (let index = 0; index < 3; index += 1) {
        dotsEl.createSpan({
            cls: "vault-coach-thinking-dot",
            text: ".",
        });
    }
}
