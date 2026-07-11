import {App, normalizePath} from "obsidian";
import { INDEX_SNAPSHOT_FILE_NAME, RUNTIME_STATE_FILE_NAME } from "./constants";
import type { KnowledgeBaseSnapshot, PersistedPluginState } from "./types";

const KNOWLEDGE_INDEX_DIR_NAME = "knowledge-index";

/**
 * 独立管理运行时状态与索引快照的本地持久化存储
 */
export class VaultCoachPersistentStore {
    private readonly app: App;
    private readonly pluginId: string;

    constructor(app: App, pluginId: string) {
        this.app = app;
        this.pluginId = pluginId;
    }

    async loadRuntimeState(): Promise<PersistedPluginState | null> {
        return this.readJsonFile<PersistedPluginState>(this.getRuntimeStatePath());
    }

    async saveRuntimeState(state: PersistedPluginState) : Promise<void> {
        await this.writeJsonFile(this.getRuntimeStatePath(), state);
    }

    async loadKnowledgeBaseSnapshot(): Promise<KnowledgeBaseSnapshot | null> {
        return this.readJsonFile<KnowledgeBaseSnapshot> (this.getIndexSnapshotPath());
    }

    async saveKnowledgeBaseSnapshot(snapshot: KnowledgeBaseSnapshot): Promise<void> {
        await this.writeJsonFile(this.getIndexSnapshotPath(), snapshot);
    }

    async loadKnowledgeIndexJson<T>(relativePath: string): Promise<T | null> {
        return this.readJsonFile<T>(this.getKnowledgeIndexPath(relativePath));
    }

    async saveKnowledgeIndexJson(relativePath: string, payload: unknown): Promise<void> {
        await this.writeJsonFile(this.getKnowledgeIndexPath(relativePath), payload);
    }

    async loadKnowledgeIndexBinary(relativePath: string): Promise<ArrayBuffer | null> {
        const path: string = this.getKnowledgeIndexPath(relativePath);
        const exists: boolean = await this.app.vault.adapter.exists(path);
        if (!exists) {
            return null;
        }

        try {
            return this.app.vault.adapter.readBinary(path);
        } catch (error: unknown) {
            console.error("[VaultCoach] 读取二进制索引文件失败", path, error);
            return null;
        }
    }

    async saveKnowledgeIndexBinary(relativePath: string, data: ArrayBuffer): Promise<void> {
        const path: string = this.getKnowledgeIndexPath(relativePath);
        await this.ensureParentDir(path);
        await this.app.vault.adapter.writeBinary(path, data);
    }

    async removeKnowledgeIndexPath(relativePath: string): Promise<void> {
        const path: string = this.getKnowledgeIndexPath(relativePath);
        if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.remove(path);
        }
    }

    async clearKnowledgeIndexSubtree(relativePath: string): Promise<void> {
        const path: string = this.getKnowledgeIndexPath(relativePath);
        if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.rmdir(path, true);
        }
    }

    private getPluginDirPath(): string {
        return normalizePath(`${this.app.vault.configDir}/plugins/${this.pluginId}`);
    }

    private getRuntimeStatePath(): string {
        return normalizePath(`${this.getPluginDirPath()}/${RUNTIME_STATE_FILE_NAME}`);
    }

    private getIndexSnapshotPath(): string {
        return normalizePath(`${this.getPluginDirPath()}/${INDEX_SNAPSHOT_FILE_NAME}`);
    }

    private getKnowledgeIndexPath(relativePath: string): string {
        return normalizePath(`${this.getPluginDirPath()}/${KNOWLEDGE_INDEX_DIR_NAME}/${relativePath}`);
    }


    private async ensurePluginDir(): Promise<void> {
        const dirPath: string = this.getPluginDirPath();
        const exists: boolean = await this.app.vault.adapter.exists(dirPath);
        if (!exists) {
            await this.app.vault.adapter.mkdir(dirPath);
        }
    }

    private async ensureParentDir(path: string): Promise<void> {
        const parts: string[] = normalizePath(path).split("/");
        parts.pop();

        let currentPath = "";
        for (const part of parts) {
            if (part.length === 0) {
                continue;
            }

            currentPath = currentPath.length === 0 ? part : `${currentPath}/${part}`;
            if (!(await this.app.vault.adapter.exists(currentPath))) {
                await this.app.vault.adapter.mkdir(currentPath);
            }
        }
    }


    private async readJsonFile<T>(path: string): Promise<T | null> {
        const exists: boolean = await this.app.vault.adapter.exists(path);
        if ( !exists        ) {
            return null;
        }

        try {
            const raw: string = await this.app.vault.adapter.read(path);
            return JSON.parse(raw) as T;
        } catch (error: unknown) {
            console.error("[VaultCoach] 读取持久化文件失败", path, error);
            return null;
        }
    }

    private async writeJsonFile(path: string, payload: unknown): Promise<void> {
        await this.ensurePluginDir();
        await this.ensureParentDir(path);
        await this.app.vault.adapter.write(path, JSON.stringify(payload));
    }
}

