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

/** 磁盘占用报告所需的只读 Vault 适配器。 */
export interface StorageFootprintAdapter {
    stat(path: string): Promise<Stat | null>;
    list(path: string): Promise<ListedFiles>;
}

/**
 * 只统计已知 Vault Coach 数据根目录。
 *
 * 本报告器严格只读，不遍历用户 Vault 中的任意其他目录。
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
            // 并发 Vault 变更最多使本次诊断不完整，不能导致数据修改或使插件其他功能失败。
            return;
        }
        for (const file of listing.files) await this.collectPath(normalizePath(file), files);
        for (const folder of listing.folders) await this.collectPath(normalizePath(folder), files);
    }
}
