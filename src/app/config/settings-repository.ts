import { CURRENT_SETTINGS_SCHEMA_VERSION, type ReadySettingsLoadResult, type SettingsMigrationWarning } from "./settings-schema";
import { migrateSettings } from "./settings-migrations";
import type { SettingsUiPreferences, VaultCoachSettings } from "./settings-types";

export interface SettingsStoragePort {
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
}

export class FutureSettingsSchemaError extends Error {
    constructor(readonly detectedVersion: number) {
        super(`设置文件来自较新的 schema 版本 ${detectedVersion}，当前插件不会覆盖该文件。`);
        this.name = "FutureSettingsSchemaError";
    }
}

/**
 * `loadData` / `saveData` 的唯一边界。
 *
 * 保存操作串行排队，避免设置控件快速变更时旧写入覆盖新写入；未知字段原样回写，
 * 从而允许同一数据文件中的其他兼容元数据安全往返。
 */
export class SettingsRepository {
    private saveQueue: Promise<void> = Promise.resolve();
    private passthrough: Record<string, unknown> = {};
    private uiPreferences: SettingsUiPreferences = { advancedSettingsExpanded: false };
    private warnings: SettingsMigrationWarning[] = [];

    constructor(private readonly storage: SettingsStoragePort) {}
    // TypeScript 的参数属性（Parameter Properties）语法糖，
    // 如果在构造器参数前面加上了访问修饰符（public、private、protected）或 readonly，TypeScript 会自动帮你声明同名属性并完成赋值，因此函数体里就不需要写 this.xxx = xxx 了

    async load(): Promise<ReadySettingsLoadResult> {
        const result = migrateSettings(await this.storage.loadData());
        if (result.status === "future-schema") {
            throw new FutureSettingsSchemaError(result.detectedVersion);
        }
        this.passthrough = { ...result.passthrough };
        this.uiPreferences = { ...result.uiPreferences };
        this.warnings = [...result.warnings];
        if (result.shouldPersist) {
            await this.save(result.settings);
        }
        return result;
    }

    save(settings: VaultCoachSettings): Promise<void> {
        const snapshot = this.serialize(settings);
        this.saveQueue = this.saveQueue.catch(() => undefined).then(() => this.storage.saveData(snapshot));
        return this.saveQueue;
    }

    async setUiPreferences(settings: VaultCoachSettings, preferences: SettingsUiPreferences): Promise<void> {
        const previousPreferences = this.uiPreferences;
        this.uiPreferences = { ...preferences };
        try {
            await this.save(settings);
        } catch (error: unknown) {
            this.uiPreferences = previousPreferences;
            throw error;
        }
    }

    getUiPreferences(): SettingsUiPreferences {
        return { ...this.uiPreferences };
    }

    getWarnings(): SettingsMigrationWarning[] {
        return this.warnings.map((warning) => ({ ...warning }));
    }

    private serialize(settings: VaultCoachSettings): Record<string, unknown> {
        return {
            ...this.passthrough,
            ...settings,
            settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
            uiPreferences: { ...this.uiPreferences },
        };
    }
}
