import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import type {
    KnowledgeScopeOption,
    KnowledgeScopeSelection,
} from "../../app/knowledge/knowledge-scope-types";
import { translate, type TranslationKey } from "../../i18n";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/** 把目录选项映射为设置用例可接收的单一选择。 */
export function toKnowledgeScopeSelection(option: KnowledgeScopeOption): KnowledgeScopeSelection {
    return option.kind === "whole-vault"
        ? { kind: "whole-vault" }
        : { kind: "folder", path: option.path };
}

/**
 * 可搜索的知识库范围选择器。
 *
 * Modal 只展示快照并返回选择；读取 Vault、保存设置和索引失效均由调用方负责。
 */
export class KnowledgeScopePickerModal extends FuzzySuggestModal<KnowledgeScopeOption> {
    constructor(
        app: App,
        private readonly options: readonly KnowledgeScopeOption[],
        private readonly onChoose: (selection: KnowledgeScopeSelection) => Promise<void>,
        private readonly onError: (error: unknown) => void,
        private readonly t: TranslateFn = translate,
    ) {
        super(app);
        this.setTitle(this.t("settings.scopePicker.title"));
        this.setPlaceholder(this.t("settings.scopePicker.placeholder"));
    }

    getItems(): KnowledgeScopeOption[] {
        return [...this.options];
    }

    getItemText(option: KnowledgeScopeOption): string {
        if (option.kind === "whole-vault") {
            return `${this.t("settings.scope.wholeVault")} ${this.t("settings.scopePicker.recommended")}`;
        }
        return option.path.length > 0 ? option.path : this.t("settings.scopePicker.unset");
    }

    renderSuggestion(match: FuzzyMatch<KnowledgeScopeOption>, element: HTMLElement): void {
        const option = match.item;
        element.addClass("vault-coach-scope-picker__item");
        if (option.selected) {
            element.addClass("is-selected");
            element.setAttribute("aria-current", "true");
        }
        if (option.kind === "legacy-folder") element.addClass("is-legacy");
        if (option.kind !== "whole-vault" && !option.exists) element.addClass("is-missing");

        const content = element.createDiv({ cls: "vault-coach-scope-picker__content" });
        if (option.kind !== "whole-vault" && option.depth === 2) {
            content.addClass("is-depth-two");
        }
        const label = content.createDiv({ cls: "vault-coach-scope-picker__label" });
        label.setText(option.kind === "whole-vault"
            ? this.t("settings.scope.wholeVault")
            : option.path || this.t("settings.scopePicker.unset"));

        const badges = content.createDiv({ cls: "vault-coach-scope-picker__badges" });
        if (option.kind === "whole-vault") {
            badges.createSpan({ text: this.t("settings.scopePicker.recommended") });
            if (this.options.length === 1) {
                badges.createSpan({ text: this.t("settings.scopePicker.empty") });
            }
        }
        if (option.selected) badges.createSpan({ text: this.t("settings.scopePicker.current") });
        if (option.kind === "legacy-folder") {
            badges.createSpan({
                text: option.exists
                    ? this.t("settings.scopePicker.legacy")
                    : this.t("settings.scopePicker.missing"),
            });
        }
    }

    onChooseItem(option: KnowledgeScopeOption): void {
        void this.onChoose(toKnowledgeScopeSelection(option)).catch(this.onError);
    }
}
