import { normalizePath } from "obsidian";
import {
    MASTERY_DIR_PATH,
    MASTERY_SNAPSHOT_PATH,
    VAULT_COACH_HIDDEN_DIR_PATH,
} from "../../constants";
import { MasteryIntegrityService } from "../../domain/mastery/mastery-integrity";
import {
    MASTERY_SNAPSHOT_SCHEMA_VERSION,
    type MasterySnapshotV1,
    type MasteryStore,
} from "../../domain/mastery/mastery-types";

/** Minimal Obsidian Vault adapter surface used by the derived Mastery cache. */
export interface MasteryStorageAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    remove(path: string): Promise<void>;
}

/**
 * Persists a disposable, versioned cache. Assessment Session JSON remains the
 * source of truth, but the same staged-write protocol keeps a crash from
 * leaving an invalid cache that obscures a later rebuild.
 */
export class JsonMasteryStore implements MasteryStore {
    private readonly integrity = new MasteryIntegrityService();

    constructor(private readonly adapter: MasteryStorageAdapter) {}

    async load(): Promise<MasterySnapshotV1 | null> {
        await this.ensureDirectories();
        await this.recoverStagedFile(MASTERY_SNAPSHOT_PATH);
        if (!(await this.adapter.exists(MASTERY_SNAPSHOT_PATH))) return null;
        return this.readSnapshot(MASTERY_SNAPSHOT_PATH);
    }

    async save(snapshot: MasterySnapshotV1): Promise<void> {
        await this.ensureDirectories();
        await this.recoverStagedFile(MASTERY_SNAPSHOT_PATH);
        this.assertSnapshot(snapshot, MASTERY_SNAPSHOT_PATH);
        await this.writeAtomically(MASTERY_SNAPSHOT_PATH, snapshot);
    }

    async clear(): Promise<void> {
        await this.ensureDirectories();
        for (const path of [MASTERY_SNAPSHOT_PATH, `${MASTERY_SNAPSHOT_PATH}.tmp`, `${MASTERY_SNAPSHOT_PATH}.bak`]) {
            if (await this.adapter.exists(path)) await this.adapter.remove(path);
        }
    }

    private async ensureDirectories(): Promise<void> {
        for (const path of [VAULT_COACH_HIDDEN_DIR_PATH, MASTERY_DIR_PATH]) {
            const normalized = normalizePath(path);
            if (!(await this.adapter.exists(normalized))) await this.adapter.mkdir(normalized);
        }
    }

    private async readSnapshot(path: string): Promise<MasterySnapshotV1> {
        let payload: unknown;
        try {
            payload = JSON.parse(await this.adapter.read(path));
        } catch (error: unknown) {
            throw new Error(`掌握度快照 JSON 无法解析：${path}（${describeError(error)}）`);
        }
        this.assertSnapshot(payload, path);
        return payload;
    }

    private async writeAtomically(path: string, snapshot: MasterySnapshotV1): Promise<void> {
        const normalized = normalizePath(path);
        const temporaryPath = `${normalized}.tmp`;
        const backupPath = `${normalized}.bak`;
        await this.adapter.write(temporaryPath, JSON.stringify(snapshot, null, 2));
        await this.readSnapshot(temporaryPath);
        if (!(await this.adapter.exists(normalized))) {
            await this.adapter.rename(temporaryPath, normalized);
            return;
        }

        if (await this.adapter.exists(backupPath)) await this.adapter.remove(backupPath);
        await this.adapter.write(backupPath, await this.adapter.read(normalized));
        try {
            await this.adapter.remove(normalized);
            await this.adapter.rename(temporaryPath, normalized);
        } catch (error: unknown) {
            if (!(await this.adapter.exists(normalized)) && await this.adapter.exists(backupPath)) {
                await this.adapter.rename(backupPath, normalized);
            }
            throw error;
        }
        if (await this.adapter.exists(backupPath)) await this.adapter.remove(backupPath);
    }

    private async recoverStagedFile(path: string): Promise<void> {
        const temporaryPath = `${path}.tmp`;
        const backupPath = `${path}.bak`;
        if (await this.adapter.exists(path)) {
            if (await this.adapter.exists(temporaryPath)) await this.adapter.remove(temporaryPath);
            if (await this.adapter.exists(backupPath)) await this.adapter.remove(backupPath);
            return;
        }
        for (const stagedPath of [temporaryPath, backupPath]) {
            if (!(await this.adapter.exists(stagedPath))) continue;
            try {
                await this.readSnapshot(stagedPath);
                await this.adapter.rename(stagedPath, path);
                if (await this.adapter.exists(temporaryPath)) await this.adapter.remove(temporaryPath);
                if (await this.adapter.exists(backupPath)) await this.adapter.remove(backupPath);
                return;
            } catch (error: unknown) {
                console.warn("[VaultCoach] 保留无法恢复的掌握度暂存文件", stagedPath, error);
            }
        }
    }

    private assertSnapshot(payload: unknown, path: string): asserts payload is MasterySnapshotV1 {
        if (!isMasterySnapshot(payload)) throw new Error(`掌握度快照格式无效：${path}`);
        const report = this.integrity.check(payload);
        if (!report.valid) throw new Error(`掌握度快照完整性校验失败：${path}（${report.issues.join(", ")}）`);
    }
}

function isMasterySnapshot(value: unknown): value is MasterySnapshotV1 {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Partial<MasterySnapshotV1>;
    return snapshot.schemaVersion === MASTERY_SNAPSHOT_SCHEMA_VERSION
        && typeof snapshot.algorithmVersion === "string"
        && Number.isFinite(snapshot.calculatedAt)
        && Number.isFinite(snapshot.sourceEventCount)
        && Array.isArray(snapshot.states)
        && Array.isArray(snapshot.unboundIssues)
        && snapshot.states.every(isMasteryState);
}

function isMasteryState(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const state = value as { conceptId?: unknown; masteryScore?: unknown; confidence?: unknown; level?: unknown; evidence?: unknown };
    return typeof state.conceptId === "string"
        && (state.masteryScore === null || typeof state.masteryScore === "number")
        && typeof state.confidence === "number"
        && typeof state.level === "string"
        && Array.isArray(state.evidence);
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
