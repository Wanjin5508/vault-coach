import {App, normalizePath} from "obsidian";
import { INDEX_SNAPSHOT_FILE_NAME, RUNTIME_STATE_FILE_NAME } from "./constants";
import type { KnowledgeBaseSnapshot, PersistedPluginState } from "./infrastructure/storage/storage-types";

const KNOWLEDGE_INDEX_DIR_NAME = "knowledge-index";

/**
 * 本地持久化存储模块。
 *
 * 统一封装插件运行时状态、知识库快照和向量索引分片的读写路径。
 * 所有数据都写在当前 vault 的插件目录中，避免访问 vault 外部文件系统。
 */
export class VaultCoachPersistentStore {
    private readonly app: App;
    private readonly pluginId: string;

    constructor(app: App, pluginId: string) {
        this.app = app;
        this.pluginId = pluginId;
    }

    /**
     * 读取会话、长期记忆和自动索引时间戳等运行时状态。
     */
    async loadRuntimeState(): Promise<PersistedPluginState | null> {
        return this.readJsonFile<PersistedPluginState>(this.getRuntimeStatePath());
    }

    /**
     * 保存运行时状态。
     */
    async saveRuntimeState(state: PersistedPluginState) : Promise<void> {
        await this.writeJsonFile(this.getRuntimeStatePath(), state);
    }

    /**
     * 读取文本索引快照。
     */
    async loadKnowledgeBaseSnapshot(): Promise<KnowledgeBaseSnapshot | null> {
        return this.readJsonFile<KnowledgeBaseSnapshot> (this.getIndexSnapshotPath());
    }

    /**
     * 保存文本索引快照。
     */
    async saveKnowledgeBaseSnapshot(snapshot: KnowledgeBaseSnapshot): Promise<void> {
        await this.writeJsonFile(this.getIndexSnapshotPath(), snapshot);
    }

    /**
     * 删除文本索引快照。
     */
    async removeKnowledgeBaseSnapshot(): Promise<void> {
        await this.removePath(this.getIndexSnapshotPath());
    }

    /**
     * 读取 knowledge-index 子目录下的 JSON 文件。
     */
    async loadKnowledgeIndexJson<T>(relativePath: string): Promise<T | null> {
        return this.readJsonFile<T>(this.getKnowledgeIndexPath(relativePath));
    }

    /**
     * 写入 knowledge-index 子目录下的 JSON 文件。
     */
    async saveKnowledgeIndexJson(relativePath: string, payload: unknown): Promise<void> {
        await this.writeJsonFile(this.getKnowledgeIndexPath(relativePath), payload);
    }

    /**
     * 读取 knowledge-index 子目录下的二进制分片。
     */
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

    /**
     * 写入 knowledge-index 子目录下的二进制分片。
     */
    async saveKnowledgeIndexBinary(relativePath: string, data: ArrayBuffer): Promise<void> {
        const path: string = this.getKnowledgeIndexPath(relativePath);
        await this.ensureParentDir(path);
        await this.app.vault.adapter.writeBinary(path, data);
    }

    /**
     * 删除 knowledge-index 子目录下的指定文件。
     */
    async removeKnowledgeIndexPath(relativePath: string): Promise<void> {
        await this.removePath(this.getKnowledgeIndexPath(relativePath));
    }

    /**
     * 删除指定 vault 相对路径。
     */
    private async removePath(path: string): Promise<void> {
        if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.remove(path);
        }
    }

    /**
     * 删除 knowledge-index 子目录下的整个子树。
     */
    async clearKnowledgeIndexSubtree(relativePath: string): Promise<void> {
        const path: string = this.getKnowledgeIndexPath(relativePath);
        if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.rmdir(path, true);
        }
    }

    /**
     * 获取当前插件在 vault 配置目录下的安装路径。
     */
    private getPluginDirPath(): string {
        return normalizePath(`${this.app.vault.configDir}/plugins/${this.pluginId}`);
    }

    /**
     * 获取运行时状态文件路径。
     */
    private getRuntimeStatePath(): string {
        return normalizePath(`${this.getPluginDirPath()}/${RUNTIME_STATE_FILE_NAME}`);
    }

    /**
     * 获取知识库快照文件路径。
     */
    private getIndexSnapshotPath(): string {
        return normalizePath(`${this.getPluginDirPath()}/${INDEX_SNAPSHOT_FILE_NAME}`);
    }

    /**
     * 获取 knowledge-index 子路径对应的完整 vault 相对路径。
     */
    private getKnowledgeIndexPath(relativePath: string): string {
        return normalizePath(`${this.getPluginDirPath()}/${KNOWLEDGE_INDEX_DIR_NAME}/${relativePath}`);
    }


    /**
     * 确保插件目录存在。
     */
    private async ensurePluginDir(): Promise<void> {
        const dirPath: string = this.getPluginDirPath();
        const exists: boolean = await this.app.vault.adapter.exists(dirPath);
        if (!exists) {
            await this.app.vault.adapter.mkdir(dirPath);
        }
    }

    /**
     * 逐级创建目标文件的父目录。
     */
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


    /**
     * 安全读取 JSON 文件；读取或解析失败时返回 null，避免损坏状态阻断插件启动。
     */
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

    /**
     * 写入 JSON 文件，并在写入前确保目录存在。
     */
    private async writeJsonFile(path: string, payload: unknown): Promise<void> {
        await this.ensurePluginDir();
        await this.ensureParentDir(path);
        await this.app.vault.adapter.write(path, JSON.stringify(payload));
    }
}
