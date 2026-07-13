import { App, normalizePath } from "obsidian";
import { EXAM_CONTENT_PROFILE_CACHE_PATH, VAULT_COACH_HIDDEN_DIR_PATH } from "../constants";
import type {
    ExamContentProfile,
    ExamContentProfileCache,
    ExamContentProfileCacheKey,
    ExamContentProfileCacheRecord,
} from "../types";

const EXAM_PROFILE_CACHE_VERSION = 1;

/**
 * 考试内容画像缓存存储。
 *
 * 缓存键包含文件路径、内容哈希、模型提供方、模型名和 prompt 版本，确保模型或提示词变化后不会误用旧画像。
 */
export class ExamProfileStore {
    private readonly app: App;
    private cache: ExamContentProfileCache | null = null;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * 根据缓存键读取内容画像。
     */
    async getProfile(key: ExamContentProfileCacheKey): Promise<ExamContentProfile | null> {
        const cache: ExamContentProfileCache = await this.loadCache();
        const record: ExamContentProfileCacheRecord | undefined = cache.records.find((item: ExamContentProfileCacheRecord) => {
            return this.cacheKeyEquals(item, key);
        });

        return record?.profile ?? null;
    }

    /**
     * 保存内容画像，并限制缓存记录数量避免隐藏目录无限增长。
     */
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

    /**
     * 清空画像缓存。
     */
    async clear(): Promise<void> {
        this.cache = {
            version: EXAM_PROFILE_CACHE_VERSION,
            records: [],
        };
        await this.writeCache(this.cache);
    }

    /**
     * 比较缓存记录与当前缓存键是否完全一致。
     */
    private cacheKeyEquals(record: ExamContentProfileCacheRecord, key: ExamContentProfileCacheKey): boolean {
        return record.filePath === key.filePath
            && record.contentHash === key.contentHash
            && record.modelProvider === key.modelProvider
            && record.modelName === key.modelName
            && record.promptVersion === key.promptVersion;
    }

    /**
     * 懒加载缓存文件。
     *
     * 读取失败时使用空缓存，避免损坏缓存阻断考试模式。
     */
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

    /**
     * 过滤缓存文件中结构明显无效的记录。
     */
    private normalizeCacheRecords(value: unknown): ExamContentProfileCacheRecord[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return value.filter((item: unknown): item is ExamContentProfileCacheRecord => {
            return item !== null && typeof item === "object";
        });
    }

    /**
     * 写入缓存文件，并确保隐藏目录存在。
     */
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
