import type { SettingsLoadSource } from "../config/settings-schema";

export const SETUP_STATE_SCHEMA_VERSION = 1 as const;

export type SetupDisposition = "pending" | "completed" | "skipped" | "grandfathered";
export type SetupEntryReason = "new-install" | "manual" | "upgrade";
export type SetupStep =
    | "scope"
    | "preparation"
    | "preparing"
    | "ready-to-index"
    | "indexing"
    | "searchable"
    | "optional-main-llm"
    | "complete";

export interface PersistedSetupStateV1 {
    schemaVersion: typeof SETUP_STATE_SCHEMA_VERSION;
    disposition: SetupDisposition;
    entryReason: SetupEntryReason;
    lastStep: SetupStep;
    updatedAt: number;
}

export function createInitialSetupState(source: SettingsLoadSource): PersistedSetupStateV1 {
    return source === "new-install"
        ? {
            schemaVersion: SETUP_STATE_SCHEMA_VERSION,
            disposition: "pending",
            entryReason: "new-install",
            lastStep: "scope",
            updatedAt: 0,
        }
        : {
            schemaVersion: SETUP_STATE_SCHEMA_VERSION,
            disposition: "grandfathered",
            entryReason: "upgrade",
            lastStep: "complete",
            updatedAt: 0,
        };
}

export function parseSetupState(value: unknown): PersistedSetupStateV1 | null {
    if (!isRecord(value)) return null;
    if (value.schemaVersion !== SETUP_STATE_SCHEMA_VERSION
        || !isDisposition(value.disposition)
        || !isEntryReason(value.entryReason)
        || !isStep(value.lastStep)
        || !isTimestamp(value.updatedAt)) return null;
    return {
        schemaVersion: SETUP_STATE_SCHEMA_VERSION,
        disposition: value.disposition,
        entryReason: value.entryReason,
        lastStep: value.lastStep,
        updatedAt: value.updatedAt,
    };
}

export function getSetupStateSchemaVersion(value: unknown): number | null {
    if (!isRecord(value) || typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) return null;
    return value.schemaVersion;
}

export function cloneSetupState(state: PersistedSetupStateV1): PersistedSetupStateV1 {
    return { ...state };
}

function isDisposition(value: unknown): value is SetupDisposition {
    return value === "pending" || value === "completed" || value === "skipped" || value === "grandfathered";
}

function isEntryReason(value: unknown): value is SetupEntryReason {
    return value === "new-install" || value === "manual" || value === "upgrade";
}

function isStep(value: unknown): value is SetupStep {
    return value === "scope" || value === "preparation" || value === "preparing"
        || value === "ready-to-index" || value === "indexing" || value === "searchable"
        || value === "optional-main-llm" || value === "complete";
}

function isTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
