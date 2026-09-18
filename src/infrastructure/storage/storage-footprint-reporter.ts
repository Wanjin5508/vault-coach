import { normalizePath, type ListedFiles, type Stat } from "obsidian";
import {
    ASSESSMENTS_DIR_PATH,
    EXAM_RESULTS_DIR_PATH,
    GRAPH_SNAPSHOT_PATH,
    MASTERY_DIR_PATH,
    RECOMMENDATIONS_DIR_PATH,
    SEMANTIC_GRAPH_DIR_PATH,
    SEMANTIC_GRAPH_MANIFEST_PATH,
} from "../../constants";
import type {
    StorageFootprint,
    StorageFootprintCategory,
    StorageFootprintEntry,
} from "../../domain/index-lifecycle/storage-footprint";
import type { VaultCoachPersistentStore } from "../../persistent-store";

export interface StorageFootprintAdapter {
    stat(path: string): Promise<Stat | null>;
    list(path: string): Promise<ListedFiles>;
}

/**
 * Counts only known VaultCoach data roots. It is deliberately read-only and
 * never walks a user's arbitrary Vault folder.
 */
export class StorageFootprintReporter {
    constructor(
        private readonly adapter: StorageFootprintAdapter,
        private readonly persistentStore: VaultCoachPersistentStore,
        private readonly now: () => number = () => Date.now(),
    ) {}

    async getFootprint(): Promise<StorageFootprint> {
        const pluginPaths = this.persistentStore.getDerivedDataPaths();
        const entries = await Promise.all([
            this.collect("text-index", [pluginPaths.textSnapshotPath]),
            this.collect("vector-index", [pluginPaths.vectorDirectoryPath]),
            this.collect("deterministic-graph", [GRAPH_SNAPSHOT_PATH]),
            this.collect("semantic-facts", [
                SEMANTIC_GRAPH_MANIFEST_PATH,
                `${SEMANTIC_GRAPH_DIR_PATH}/sections`,
                `${SEMANTIC_GRAPH_DIR_PATH}/concepts`,
                `${SEMANTIC_GRAPH_DIR_PATH}/candidates`,
                `${SEMANTIC_GRAPH_DIR_PATH}/decisions-v1.json`,
            ]),
            this.collect("semantic-embeddings", [`${SEMANTIC_GRAPH_DIR_PATH}/embeddings`]),
            this.collect("mastery", [MASTERY_DIR_PATH]),
            this.collect("recommendation-actions", [RECOMMENDATIONS_DIR_PATH]),
            this.collect("assessments", [ASSESSMENTS_DIR_PATH]),
            this.collect("exam-reports", [EXAM_RESULTS_DIR_PATH]),
        ]);
        return {
            generatedAt: this.now(),
            totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
            entries,
        };
    }

    private async collect(category: StorageFootprintCategory, roots: readonly string[]): Promise<StorageFootprintEntry> {
        const files = new Map<string, Stat>();
        for (const root of roots) await this.collectPath(normalizePath(root), files);
        const allStats = Array.from(files.values());
        return {
            category,
            bytes: allStats.reduce((sum, stat) => sum + stat.size, 0),
            fileCount: allStats.length,
            latestModifiedAt: allStats.reduce<number | null>((latest, stat) => (
                latest === null || stat.mtime > latest ? stat.mtime : latest
            ), null),
            recordCount: null,
        };
    }

    private async collectPath(path: string, files: Map<string, Stat>): Promise<void> {
        let stat: Stat | null;
        try {
            stat = await this.adapter.stat(path);
        } catch {
            return;
        }
        if (!stat) return;
        if (stat.type === "file") {
            files.set(path, stat);
            return;
        }
        let listing: ListedFiles;
        try {
            listing = await this.adapter.list(path);
        } catch {
            // A concurrent vault change should make this diagnostic incomplete,
            // never make it mutate data or fail the rest of the plugin.
            return;
        }
        for (const file of listing.files) await this.collectPath(normalizePath(file), files);
        for (const folder of listing.folders) await this.collectPath(normalizePath(folder), files);
    }
}
