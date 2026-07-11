import { App, normalizePath } from "obsidian";
import { EXAM_CONTENT_PROFILE_CACHE_PATH, VAULT_COACH_HIDDEN_DIR_PATH } from "../constants";
import type {
    ExamContentProfile,
    ExamContentProfileCache,
    ExamContentProfileCacheKey,
    ExamContentProfileCacheRecord,
} from "../types";

const EXAM_PROFILE_CACHE_VERSION = 1;

export class ExamProfileStore {
    private readonly app: App;
    private cache: ExamContentProfileCache | null = null;

    constructor(app: App) {
        this.app = app;
    }

    async getProfile(key: ExamContentProfileCacheKey): Promise<ExamContentProfile | null> {
        const cache: ExamContentProfileCache = await this.loadCache();
        const record: ExamContentProfileCacheRecord | undefined = cache.records.find((item: ExamContentProfileCacheRecord) => {
            return this.cacheKeyEquals(item, key);
        });

        return record?.profile ?? null;
    }

    async saveProfile(key: ExamContentProfileCacheKey, profile: ExamContentProfile): Promise<void> {
        const cache: ExamContentProfileCache = await this.loadCache();
        const nextRecord: ExamContentProfileCacheRecord = {
            ...key,
            profile,
            updatedAt: Date.now(),
        };

        const nextRecords: ExamContentProfileCacheRecord[] = cache.records.filter((record: ExamContentProfileCacheRecord) => {
            return !this.cacheKeyEquals(record, key);
        });
        nextRecords.unshift(nextRecord);

        this.cache = {
            version: EXAM_PROFILE_CACHE_VERSION,
            records: nextRecords.slice(0, 1000),
        };
        await this.writeCache(this.cache);
    }

    async clear(): Promise<void> {
        this.cache = {
            version: EXAM_PROFILE_CACHE_VERSION,
            records: [],
        };
        await this.writeCache(this.cache);
    }

    private cacheKeyEquals(record: ExamContentProfileCacheRecord, key: ExamContentProfileCacheKey): boolean {
        return record.filePath === key.filePath
            && record.contentHash === key.contentHash
            && record.modelProvider === key.modelProvider
            && record.modelName === key.modelName
            && record.promptVersion === key.promptVersion;
    }

    private async loadCache(): Promise<ExamContentProfileCache> {
        if (this.cache) {
            return this.cache;
        }

        const normalizedPath: string = normalizePath(EXAM_CONTENT_PROFILE_CACHE_PATH);
        const exists: boolean = await this.app.vault.adapter.exists(normalizedPath);
        if (!exists) {
            this.cache = {
                version: EXAM_PROFILE_CACHE_VERSION,
                records: [],
            };
            return this.cache;
        }

        try {
            const raw: string = await this.app.vault.adapter.read(normalizedPath);
            const parsed: unknown = JSON.parse(raw) as unknown;
            const parsedRecord: Record<string, unknown> = parsed !== null && typeof parsed === "object"
                ? parsed as Record<string, unknown>
                : {};
            this.cache = {
                version: EXAM_PROFILE_CACHE_VERSION,
                records: this.normalizeCacheRecords(parsedRecord["records"]),
            };
            return this.cache;
        } catch (error: unknown) {
            console.error("[VaultCoach] 读取考试内容画像缓存失败，将使用空缓存。", error);
            this.cache = {
                version: EXAM_PROFILE_CACHE_VERSION,
                records: [],
            };
            return this.cache;
        }
    }

    private normalizeCacheRecords(value: unknown): ExamContentProfileCacheRecord[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return value.filter((item: unknown): item is ExamContentProfileCacheRecord => {
            return item !== null && typeof item === "object";
        });
    }

    private async writeCache(cache: ExamContentProfileCache): Promise<void> {
        const hiddenDirPath: string = normalizePath(VAULT_COACH_HIDDEN_DIR_PATH);
        if (!(await this.app.vault.adapter.exists(hiddenDirPath))) {
            await this.app.vault.adapter.mkdir(hiddenDirPath);
        }

        await this.app.vault.adapter.write(
            normalizePath(EXAM_CONTENT_PROFILE_CACHE_PATH),
            JSON.stringify(cache),
        );
    }
}
