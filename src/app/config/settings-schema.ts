import type { SettingsUiPreferences, VaultCoachSettings } from "./settings-types";

export const CURRENT_SETTINGS_SCHEMA_VERSION = 1 as const;

export interface SettingsMigrationWarning {
    code: "invalid-type" | "invalid-value" | "invalid-schema-version";
    field?: string;
    message: string;
}

export interface PersistedVaultCoachSettingsV1 extends VaultCoachSettings {
    settingsSchemaVersion: typeof CURRENT_SETTINGS_SCHEMA_VERSION;
    uiPreferences?: SettingsUiPreferences;
}

export type SettingsLoadSource = "new-install" | "legacy" | "current";

export interface ReadySettingsLoadResult {
    status: "ready";
    source: SettingsLoadSource;
    settings: VaultCoachSettings;
    uiPreferences: SettingsUiPreferences;
    warnings: SettingsMigrationWarning[];
    passthrough: Record<string, unknown>;
    shouldPersist: boolean;
}

export interface FutureSettingsLoadResult {
    status: "future-schema";
    detectedVersion: number;
}

export type SettingsLoadResult = ReadySettingsLoadResult | FutureSettingsLoadResult;

export function isSettingsRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRetrievalMode(value: unknown): value is "keyword" | "vector" | "hybrid" {
    return value === "keyword" || value === "vector" || value === "hybrid";
}

export function isRetrievalPreference(value: unknown): value is "auto" | "keyword" | "vector" | "hybrid" {
    return value === "auto" || isRetrievalMode(value);
}
