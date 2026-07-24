import { Modal, type App } from "obsidian";

export interface ConfirmActionModalOptions {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm(): Promise<void>;
}

/** A small, version-compatible confirmation modal for locally destructive actions. */
export class ConfirmActionModal extends Modal {
    private submitting = false;

    constructor(app: App, private readonly options: ConfirmActionModalOptions) {
        super(app);
    }

    onOpen(): void {
        this.setTitle(this.options.title);
        this.contentEl.createEl("p", { text: this.options.description });
        const actions = this.contentEl.createDiv({ cls: "vault-coach-confirm-actions" });
        const cancel = actions.createEl("button", { text: this.options.cancelLabel, attr: { type: "button" } });
        const confirm = actions.createEl("button", {
            text: this.options.confirmLabel,
            cls: "mod-warning",
            attr: { type: "button" },
        });
        cancel.addEventListener("click", () => this.close());
        confirm.addEventListener("click", () => void this.confirm(confirm, cancel));
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async confirm(confirmButton: HTMLButtonElement, cancelButton: HTMLButtonElement): Promise<void> {
        if (this.submitting) return;
        this.submitting = true;
        confirmButton.disabled = true;
        cancelButton.disabled = true;
        try {
            await this.options.onConfirm();
            this.close();
        } catch {
            this.submitting = false;
            confirmButton.disabled = false;
            cancelButton.disabled = false;
        }
    }
}
