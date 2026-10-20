import type { Setting } from "obsidian";

export interface AdvancedDisclosureOptions {
    expanded: boolean;
    title: string;
    summary: string;
    contentId: string;
    expandLabel: string;
    collapseLabel: string;
    onToggle(expanded: boolean): Promise<void>;
    onError(error: unknown): void;
}

/** 渲染可访问的进阶设置 disclosure；原生 button 自带 Enter 和 Space 键盘行为。 */
export function renderAdvancedDisclosure(
    setting: Setting,
    options: AdvancedDisclosureOptions,
): () => void {
    setting.settingEl.empty();
    setting.settingEl.addClass("vault-coach-settings__advanced-disclosure-row");
    const button = setting.settingEl.createEl("button", {
        cls: "vault-coach-settings__advanced-disclosure",
        attr: {
            type: "button",
            "aria-expanded": String(options.expanded),
            "aria-controls": options.contentId,
            "aria-label": options.expanded ? options.collapseLabel : options.expandLabel,
        },
    });
    const text = button.createSpan({ cls: "vault-coach-settings__advanced-disclosure-text" });
    text.createSpan({ cls: "vault-coach-settings__advanced-disclosure-title", text: options.title });
    text.createSpan({ cls: "vault-coach-settings__advanced-disclosure-summary", text: options.summary });
    button.createSpan({
        cls: "vault-coach-settings__advanced-disclosure-icon",
        text: options.expanded ? "⌄" : "›",
        attr: { "aria-hidden": "true" },
    });

    const handleClick = (): void => {
        button.disabled = true;
        void options.onToggle(!options.expanded)
            .catch((error: unknown) => options.onError(error))
            .finally(() => { button.disabled = false; });
    };
    button.addEventListener("click", handleClick);
    return () => button.removeEventListener("click", handleClick);
}
