import { Modal, type App } from "obsidian";
import type { StorageFootprint, StorageFootprintCategory } from "../../domain/index-lifecycle/storage-footprint";
import { formatDateTime } from "../../ui/view-formatters";
import type { TranslationKey } from "../../i18n";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

export interface StorageFootprintModalOptions {
    getFootprint(): Promise<StorageFootprint>;
    t: TranslateFn;
}

/** Read-only view of only the VaultCoach-controlled derived-data roots. */
export class StorageFootprintModal extends Modal {
    constructor(app: App, private readonly options: StorageFootprintModalOptions) {
        super(app);
    }

    onOpen(): void {
        this.setTitle(this.options.t("storageFootprint.title"));
        this.contentEl.createDiv({ text: this.options.t("storageFootprint.loading") });
        void this.load();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async load(): Promise<void> {
        try {
            const footprint = await this.options.getFootprint();
            if (!this.contentEl.isConnected) return;
            this.contentEl.empty();
            this.contentEl.createDiv({
                cls: "vault-coach-storage-footprint-summary",
                text: this.options.t("storageFootprint.summary", { bytes: formatBytes(footprint.totalBytes) }),
            });
            const list = this.contentEl.createDiv({ cls: "vault-coach-storage-footprint-list" });
            for (const entry of footprint.entries) {
                const row = list.createDiv({ cls: "vault-coach-storage-footprint-row" });
                row.createDiv({ text: this.getCategoryLabel(entry.category) });
                const detail = [
                    this.options.t("storageFootprint.files", { count: entry.fileCount }),
                    entry.recordCount === null ? null : this.options.t("storageFootprint.records", { count: entry.recordCount }),
                    formatBytes(entry.bytes),
                    entry.latestModifiedAt === null ? null : this.options.t("storageFootprint.updated", { time: formatDateTime(entry.latestModifiedAt) }),
                ].filter((value): value is string => value !== null).join(" · ");
                row.createDiv({ cls: "vault-coach-storage-footprint-detail", text: detail });
            }
            this.contentEl.createDiv({
                cls: "vault-coach-storage-footprint-note",
                text: this.options.t("storageFootprint.note"),
            });
        } catch {
            if (!this.contentEl.isConnected) return;
            this.contentEl.empty();
            this.contentEl.createDiv({ text: this.options.t("storageFootprint.failed") });
        }
    }

    private getCategoryLabel(category: StorageFootprintCategory): string {
        const key: Record<StorageFootprintCategory, TranslationKey> = {
            "text-index": "storageFootprint.category.textIndex",
            "vector-index": "storageFootprint.category.vectorIndex",
            "deterministic-graph": "storageFootprint.category.deterministicGraph",
            "semantic-facts": "storageFootprint.category.semanticFacts",
            "semantic-embeddings": "storageFootprint.category.semanticEmbeddings",
            mastery: "storageFootprint.category.mastery",
            assessments: "storageFootprint.category.assessments",
            "exam-reports": "storageFootprint.category.examReports",
        };
        return this.options.t(key[category]);
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
