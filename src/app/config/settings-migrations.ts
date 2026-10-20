import { DEFAULT_SETTINGS_UI_PREFERENCES, createDefaultSettings } from "./settings-defaults";
import {
    CURRENT_SETTINGS_SCHEMA_VERSION,
    isRetrievalMode,
    isRetrievalPreference,
    isSettingsRecord,
    type SettingsLoadResult,
    type SettingsMigrationWarning,
} from "./settings-schema";
import type { SettingsUiPreferences, VaultCoachSettings } from "./settings-types";

const RESERVED_KEYS = new Set(["settingsSchemaVersion", "uiPreferences"]);

/**
 * 将磁盘中的未知数据迁移并规范化为当前设置。
 *
 * 迁移按字段复制，显式保留 `false`、`0` 和空字符串；非法值只回退对应字段，
 * 且告警不包含用户配置内容，避免把路径或模型信息写入日志。
 */
export function migrateSettings(raw: unknown): SettingsLoadResult {
    const defaults = createDefaultSettings();
    const rawIsRecord = isSettingsRecord(raw);
    const record = rawIsRecord ? raw : {};
    const isNewInstall = raw === null || raw === undefined || (rawIsRecord && Object.keys(record).length === 0);
    const version = record.settingsSchemaVersion;

    if (typeof version === "number" && Number.isInteger(version) && version > CURRENT_SETTINGS_SCHEMA_VERSION) {
        return { status: "future-schema", detectedVersion: version };
    }

    const warnings: SettingsMigrationWarning[] = [];
    if (!rawIsRecord && raw !== null && raw !== undefined) {
        warnings.push({ code: "invalid-type", message: "设置根节点类型无效，已按旧版损坏配置恢复。" });
    }
    if (version !== undefined && (!Number.isInteger(version) || Number(version) < 0)) {
        warnings.push({
            code: "invalid-schema-version",
            field: "settingsSchemaVersion",
            message: "设置版本无效，已按旧版配置迁移。",
        });
    }

    const settings = normalizeSettings(record, defaults, warnings);
    if (!isRetrievalPreference(record.retrievalPreference)) {
        if (!isNewInstall && isRetrievalMode(record.defaultRetrievalMode)) {
            settings.retrievalPreference = record.defaultRetrievalMode;
        } else {
            settings.retrievalPreference = defaults.retrievalPreference;
        }
    }

    // 兼容字段保持与显式偏好同步，便于旧版回滚读取。
    settings.defaultRetrievalMode = settings.retrievalPreference === "auto"
        ? defaults.defaultRetrievalMode
        : settings.retrievalPreference;

    const uiPreferences = normalizeUiPreferences(record.uiPreferences, warnings);
    const settingKeys = new Set(Object.keys(defaults));
    const passthrough: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (!settingKeys.has(key) && !RESERVED_KEYS.has(key)) {
            passthrough[key] = value;
        }
    }

    const currentVersion = version === CURRENT_SETTINGS_SCHEMA_VERSION;
    return {
        status: "ready",
        source: isNewInstall ? "new-install" : currentVersion ? "current" : "legacy",
        settings,
        uiPreferences,
        warnings,
        passthrough,
        shouldPersist: !currentVersion || warnings.length > 0 || !isSettingsRecord(record.uiPreferences),
    };
}

function normalizeSettings(
    record: Record<string, unknown>,
    defaults: VaultCoachSettings,
    warnings: SettingsMigrationWarning[],
): VaultCoachSettings {
    const normalized = { ...defaults };
    for (const key of Object.keys(defaults) as Array<keyof VaultCoachSettings>) {
        if (!(key in record)) continue;
        const candidate = record[key];
        const fallback = defaults[key];
        if (typeof candidate !== typeof fallback) {
            warnings.push({ code: "invalid-type", field: key, message: `设置字段 ${key} 类型无效，已使用默认值。` });
            continue;
        }
        (normalized as unknown as Record<string, unknown>)[key] = candidate;
    }

    if (record.knowledgeScopeMode !== undefined && record.knowledgeScopeMode !== "wholeVault" && record.knowledgeScopeMode !== "specificFolder") {
        normalized.knowledgeScopeMode = defaults.knowledgeScopeMode;
        addInvalidValue(warnings, "knowledgeScopeMode");
    }
    if (record.modelProvider !== undefined && record.modelProvider !== "ollama" && record.modelProvider !== "openai-compatible") {
        normalized.modelProvider = defaults.modelProvider;
        addInvalidValue(warnings, "modelProvider");
    }
    if (record.embeddingProvider !== undefined && record.embeddingProvider !== "ollama" && record.embeddingProvider !== "openai-compatible") {
        normalized.embeddingProvider = defaults.embeddingProvider;
        addInvalidValue(warnings, "embeddingProvider");
    }
    if (record.defaultRetrievalMode !== undefined && !isRetrievalMode(record.defaultRetrievalMode)) {
        normalized.defaultRetrievalMode = defaults.defaultRetrievalMode;
        addInvalidValue(warnings, "defaultRetrievalMode");
    }
    if (record.retrievalPreference !== undefined && !isRetrievalPreference(record.retrievalPreference)) {
        normalized.retrievalPreference = defaults.retrievalPreference;
        addInvalidValue(warnings, "retrievalPreference");
    }

    validateNumberRanges(normalized, defaults, warnings);
    return normalized;
}

function validateNumberRanges(
    settings: VaultCoachSettings,
    defaults: VaultCoachSettings,
    warnings: SettingsMigrationWarning[],
): void {
    const positive: Array<keyof VaultCoachSettings> = [
        "maxPdfFileSizeMb", "maxPdfPageCount", "chunkSize", "keywordSearchTopK", "vectorSearchTopK",
        "hybridSearchTopK", "rerankTopK", "contextTopK", "answerSourceLimit", "memoryTopK",
        "memoryMaxItems", "maxConversationMessages", "autoIndexDebounceMs", "autoIndexMaxWaitMs",
        "autoIndexFileThreshold", "semanticGraphMaxSectionsPerRun", "semanticGraphMaxSectionCharacters",
        "semanticGraphSimilarityTopK",
    ];
    for (const key of positive) {
        const value = settings[key];
        if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
            setDefault(settings, defaults, key);
            addInvalidValue(warnings, key);
        }
    }
    if (!Number.isFinite(settings.chunkOverlap) || settings.chunkOverlap < 0) {
        settings.chunkOverlap = defaults.chunkOverlap;
        addInvalidValue(warnings, "chunkOverlap");
    }
    validateRange(settings, defaults, warnings, "generationTemperature", 0, 2);
    validateRange(settings, defaults, warnings, "semanticGraphSimilarityThreshold", 0, 1);
    validateRange(settings, defaults, warnings, "learningMapAutoModelThreshold", 0.7, 1);
}

function validateRange(
    settings: VaultCoachSettings,
    defaults: VaultCoachSettings,
    warnings: SettingsMigrationWarning[],
    key: "generationTemperature" | "semanticGraphSimilarityThreshold" | "learningMapAutoModelThreshold",
    min: number,
    max: number,
): void {
    const value = settings[key];
    if (!Number.isFinite(value) || value < min || value > max) {
        settings[key] = defaults[key];
        addInvalidValue(warnings, key);
    }
}

function setDefault(settings: VaultCoachSettings, defaults: VaultCoachSettings, key: keyof VaultCoachSettings): void {
    (settings as unknown as Record<string, unknown>)[key] = defaults[key];
}

function addInvalidValue(warnings: SettingsMigrationWarning[], field: keyof VaultCoachSettings): void {
    if (warnings.some((warning) => warning.code === "invalid-value" && warning.field === field)) return;
    warnings.push({ code: "invalid-value", field, message: `设置字段 ${field} 的值无效，已使用默认值。` });
}

function normalizeUiPreferences(raw: unknown, warnings: SettingsMigrationWarning[]): SettingsUiPreferences {
    if (!isSettingsRecord(raw)) return { ...DEFAULT_SETTINGS_UI_PREFERENCES };
    if (raw.advancedSettingsExpanded !== undefined && typeof raw.advancedSettingsExpanded !== "boolean") {
        warnings.push({ code: "invalid-type", field: "uiPreferences.advancedSettingsExpanded", message: "高级设置展开状态无效，已折叠。" });
    }
    return {
        advancedSettingsExpanded: typeof raw.advancedSettingsExpanded === "boolean"
            ? raw.advancedSettingsExpanded
            : DEFAULT_SETTINGS_UI_PREFERENCES.advancedSettingsExpanded,
    };
}
