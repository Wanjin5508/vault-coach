import { normalizePath } from "obsidian";
import {
    GRAPH_DIR_PATH,
    GRAPH_SNAPSHOT_PATH,
    VAULT_COACH_HIDDEN_DIR_PATH,
} from "../../constants";
import { GraphIntegrityService } from "../../domain/graph/graph-integrity-service";
import { GRAPH_SNAPSHOT_SCHEMA_VERSION } from "../../domain/graph/graph-types";
import type { GraphSnapshotV1 } from "../../domain/graph/graph-types";
import type { GraphStore } from "../../domain/graph/graph-store";

/** Minimal Vault adapter surface required to persist one recoverable graph snapshot. */
export interface GraphStorageAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    remove(path: string): Promise<void>;
}

/**
 * Vault-adapter implementation for the deterministic graph source of truth.
 *
 * Graph facts are reconstructible, but never silently replace a valid snapshot
 * with malformed JSON. A temporary file is validated before replacement and a
 * backup is retained long enough to restore a failed replacement.
 */
export class JsonGraphStore implements GraphStore {
    private readonly integrity = new GraphIntegrityService();

    constructor(private readonly adapter: GraphStorageAdapter) {}

    async load(): Promise<GraphSnapshotV1 | null> {
        await this.ensureDirectories();
        await this.recoverStagedSnapshot();
        if (!(await this.adapter.exists(GRAPH_SNAPSHOT_PATH))) {
            return null;
        }

        return this.readSnapshotAtPath(GRAPH_SNAPSHOT_PATH);
    }

    async save(snapshot: GraphSnapshotV1): Promise<void> {
        await this.ensureDirectories();
        await this.recoverStagedSnapshot();
        this.assertSnapshot(snapshot, GRAPH_SNAPSHOT_PATH);
        await this.writeSnapshotAtomically(snapshot);
    }

    async clear(): Promise<void> {
        await this.ensureDirectories();
        await this.removeIfPresent(GRAPH_SNAPSHOT_PATH);
        await this.removeIfPresent(this.getTemporaryPath());
        await this.removeIfPresent(this.getBackupPath());
    }

    private async writeSnapshotAtomically(snapshot: GraphSnapshotV1): Promise<void> {
        const temporaryPath = this.getTemporaryPath();
        const backupPath = this.getBackupPath();
        const serialized = JSON.stringify(snapshot, null, 2);

        await this.adapter.write(temporaryPath, serialized);
        await this.readSnapshotAtPath(temporaryPath);

        if (!(await this.adapter.exists(GRAPH_SNAPSHOT_PATH))) {
            await this.adapter.rename(temporaryPath, GRAPH_SNAPSHOT_PATH);
            return;
        }

        if (await this.adapter.exists(backupPath)) {
            await this.adapter.remove(backupPath);
        }
        await this.adapter.write(backupPath, await this.adapter.read(GRAPH_SNAPSHOT_PATH));

        try {
            await this.adapter.remove(GRAPH_SNAPSHOT_PATH);
            await this.adapter.rename(temporaryPath, GRAPH_SNAPSHOT_PATH);
        } catch (error: unknown) {
            await this.restoreBackup();
            throw error;
        }

        try {
            await this.removeIfPresent(backupPath);
        } catch (error: unknown) {
            console.warn("[VaultCoach] 图谱快照已更新，但旧备份文件暂未清理", backupPath, error);
        }
    }

    private async recoverStagedSnapshot(): Promise<void> {
        const temporaryPath = this.getTemporaryPath();
        const backupPath = this.getBackupPath();
        if (await this.adapter.exists(GRAPH_SNAPSHOT_PATH)) {
            await this.removeIfPresent(temporaryPath);
            await this.removeIfPresent(backupPath);
            return;
        }

        for (const stagedPath of [temporaryPath, backupPath]) {
            if (!(await this.adapter.exists(stagedPath))) continue;

            try {
                await this.readSnapshotAtPath(stagedPath);
                await this.adapter.rename(stagedPath, GRAPH_SNAPSHOT_PATH);
                await this.removeIfPresent(temporaryPath);
                await this.removeIfPresent(backupPath);
                return;
            } catch (error: unknown) {
                console.warn("[VaultCoach] 保留无法恢复的图谱快照暂存文件", stagedPath, error);
            }
        }
    }

    private async restoreBackup(): Promise<void> {
        const backupPath = this.getBackupPath();
        if (await this.adapter.exists(GRAPH_SNAPSHOT_PATH) || !(await this.adapter.exists(backupPath))) {
            return;
        }

        try {
            await this.adapter.rename(backupPath, GRAPH_SNAPSHOT_PATH);
        } catch (error: unknown) {
            console.error("[VaultCoach] 无法立即恢复图谱快照备份", backupPath, error);
        }
    }

    private async readSnapshotAtPath(path: string): Promise<GraphSnapshotV1> {
        let payload: unknown;
        try {
            payload = JSON.parse(await this.adapter.read(path));
        } catch (error: unknown) {
            throw new Error(`图谱快照 JSON 无法解析：${path}（${this.describeError(error)}）`);
        }

        this.assertSnapshot(payload, path);
        return payload;
    }

    private assertSnapshot(value: unknown, path: string): asserts value is GraphSnapshotV1 {
        if (this.isRecord(value) && value.schemaVersion !== GRAPH_SNAPSHOT_SCHEMA_VERSION) {
            throw new Error(`图谱快照 schema 不受支持：${path}`);
        }
        if (!this.isSnapshotShape(value)) {
            throw new Error(`图谱快照 JSON 格式无效：${path}`);
        }

        const report = this.integrity.check(value);
        if (!report.valid) {
            const issueCodes = Array.from(new Set(report.issues.map((issue) => issue.code))).join(", ");
            throw new Error(`图谱快照完整性校验失败：${path}（${issueCodes}）`);
        }
    }

    private isSnapshotShape(value: unknown): value is GraphSnapshotV1 {
        if (!this.isRecord(value)
            || value.schemaVersion !== GRAPH_SNAPSHOT_SCHEMA_VERSION
            || !Array.isArray(value.nodes)
            || !Array.isArray(value.edges)
            || !this.isRecord(value.stats)
            || !this.isNonNegativeInteger(value.stats.documentCount)
            || !this.isNonNegativeInteger(value.stats.sectionCount)
            || !this.isNonNegativeInteger(value.stats.tagCount)
            || !this.isNonNegativeInteger(value.stats.edgeCount)) {
            return false;
        }

        return value.nodes.every((node: unknown) => this.isNodeShape(node))
            && value.edges.every((edge: unknown) => this.isEdgeShape(edge));
    }

    private isNodeShape(value: unknown): boolean {
        if (!this.isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
            return false;
        }
        if (value.type === "document") {
            return typeof value.documentId === "string"
                && typeof value.filePath === "string"
                && typeof value.documentType === "string"
                && typeof value.title === "string"
                && typeof value.contentHash === "string"
                && (value.modifiedAt === null || this.isFiniteNumber(value.modifiedAt));
        }
        if (value.type === "section") {
            return typeof value.documentId === "string"
                && typeof value.filePath === "string"
                && Array.isArray(value.headingPath)
                && value.headingPath.every((heading: unknown) => typeof heading === "string")
                && this.isNonNegativeInteger(value.occurrence)
                && Array.isArray(value.chunkIds)
                && value.chunkIds.every((chunkId: unknown) => typeof chunkId === "string")
                && this.isDocumentLocator(value.locator);
        }
        return value.type === "tag"
            && typeof value.normalizedName === "string"
            && typeof value.displayName === "string";
    }

    private isEdgeShape(value: unknown): boolean {
        return this.isRecord(value)
            && typeof value.id === "string"
            && typeof value.sourceNodeId === "string"
            && typeof value.targetNodeId === "string"
            && (value.type === "contains" || value.type === "links_to" || value.type === "embeds" || value.type === "tagged_with")
            && this.isFiniteNumber(value.confidence)
            && (value.origin === "heading-structure"
                || value.origin === "obsidian-link"
                || value.origin === "obsidian-embed"
                || value.origin === "obsidian-tag")
            && Array.isArray(value.sources)
            && value.sources.every((source: unknown) => this.isSourceLocation(source));
    }

    private isSourceLocation(value: unknown): boolean {
        if (!this.isRecord(value)
            || typeof value.sourceFilePath !== "string"
            || typeof value.sourceDocumentId !== "string"
            || (value.sourceKind !== "heading-structure"
                && value.sourceKind !== "obsidian-link"
                && value.sourceKind !== "obsidian-embed"
                && value.sourceKind !== "obsidian-tag")
            || (value.targetFilePath !== undefined && typeof value.targetFilePath !== "string")
            || !Array.isArray(value.chunkIds)
            || !value.chunkIds.every((chunkId: unknown) => typeof chunkId === "string")) {
            return false;
        }

        return [value.startLine, value.startColumn, value.endLine, value.endColumn]
            .every((position: unknown) => position === undefined || this.isNonNegativeInteger(position));
    }

    private isDocumentLocator(value: unknown): boolean {
        if (!this.isRecord(value) || typeof value.type !== "string") return false;
        if (value.type === "markdown") {
            return typeof value.filePath === "string" && (value.heading === undefined || typeof value.heading === "string");
        }
        if (value.type === "pdf") {
            return typeof value.filePath === "string"
                && this.isNonNegativeInteger(value.pageStart)
                && (value.pageEnd === undefined || this.isNonNegativeInteger(value.pageEnd));
        }
        return value.type === "zotero"
            && typeof value.itemKey === "string"
            && (value.attachmentKey === undefined || typeof value.attachmentKey === "string")
            && (value.citationKey === undefined || typeof value.citationKey === "string")
            && (value.pageStart === undefined || this.isNonNegativeInteger(value.pageStart))
            && (value.pageEnd === undefined || this.isNonNegativeInteger(value.pageEnd));
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    private isFiniteNumber(value: unknown): value is number {
        return typeof value === "number" && Number.isFinite(value);
    }

    private isNonNegativeInteger(value: unknown): value is number {
        return this.isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
    }

    private async ensureDirectories(): Promise<void> {
        for (const path of [VAULT_COACH_HIDDEN_DIR_PATH, GRAPH_DIR_PATH]) {
            const normalizedPath = normalizePath(path);
            if (!(await this.adapter.exists(normalizedPath))) {
                await this.adapter.mkdir(normalizedPath);
            }
        }
    }

    private async removeIfPresent(path: string): Promise<void> {
        if (await this.adapter.exists(path)) {
            await this.adapter.remove(path);
        }
    }

    private getTemporaryPath(): string {
        return `${normalizePath(GRAPH_SNAPSHOT_PATH)}.tmp`;
    }

    private getBackupPath(): string {
        return `${normalizePath(GRAPH_SNAPSHOT_PATH)}.bak`;
    }

    private describeError(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
