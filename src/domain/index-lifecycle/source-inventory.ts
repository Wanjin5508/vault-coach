/**
 * A cheap, local-only description of the files that supplied a knowledge index.
 * It deliberately uses file metadata rather than document contents so plugin
 * startup can reject stale caches without scanning or uploading the Vault.
 */
export const SOURCE_INVENTORY_SCHEMA_VERSION = 1 as const;

export type SourceInventoryStatus =
    | "not-indexed"
    | "ready"
    | "source-sync-required"
    | "possible-domain-switch";

export interface SourceInventoryFile {
    path: string;
    size: number;
    modifiedAt: number;
}

export interface SourceInventoryV1 {
    schemaVersion: typeof SOURCE_INVENTORY_SCHEMA_VERSION;
    scopeSignature: string;
    files: SourceInventoryFile[];
    fingerprint: string;
    generatedAt: number;
}

export interface SourceInventoryDiff {
    addedPaths: string[];
    removedPaths: string[];
    modifiedPaths: string[];
    unchangedCount: number;
    changedRatio: number;
    isPossibleDomainSwitch: boolean;
}

export function createSourceInventory(
    scopeSignature: string,
    files: readonly SourceInventoryFile[],
    generatedAt: number = Date.now(),
): SourceInventoryV1 {
    const normalizedFiles = normalizeFiles(files);
    return {
        schemaVersion: SOURCE_INVENTORY_SCHEMA_VERSION,
        scopeSignature: scopeSignature.trim(),
        files: normalizedFiles,
        fingerprint: fingerprint(scopeSignature.trim(), normalizedFiles),
        generatedAt: normalizeTimestamp(generatedAt),
    };
}

export function compareSourceInventories(
    previous: SourceInventoryV1,
    current: SourceInventoryV1,
): SourceInventoryDiff {
    const previousByPath = new Map(previous.files.map((file) => [file.path, file]));
    const currentByPath = new Map(current.files.map((file) => [file.path, file]));
    const addedPaths: string[] = [];
    const removedPaths: string[] = [];
    const modifiedPaths: string[] = [];
    let unchangedCount = 0;

    for (const [path, file] of currentByPath) {
        const oldFile = previousByPath.get(path);
        if (!oldFile) {
            addedPaths.push(path);
            continue;
        }
        if (oldFile.size !== file.size || oldFile.modifiedAt !== file.modifiedAt) {
            modifiedPaths.push(path);
            continue;
        }
        unchangedCount += 1;
    }
    for (const path of previousByPath.keys()) {
        if (!currentByPath.has(path)) removedPaths.push(path);
    }

    addedPaths.sort();
    removedPaths.sort();
    modifiedPaths.sort();
    const changeCount = addedPaths.length + removedPaths.length + modifiedPaths.length;
    const denominator = Math.max(previous.files.length, current.files.length, 1);
    const changedRatio = changeCount / denominator;
    const isPossibleDomainSwitch = (
        previous.files.length > 0
        && current.files.length > 0
        && unchangedCount === 0
    ) || changedRatio >= 0.7;
    return { addedPaths, removedPaths, modifiedPaths, unchangedCount, changedRatio, isPossibleDomainSwitch };
}

export function getSourceInventoryStatus(
    previous: SourceInventoryV1 | undefined,
    current: SourceInventoryV1,
): { status: SourceInventoryStatus; diff: SourceInventoryDiff | null } {
    if (!previous || !isSourceInventory(previous)) return { status: "source-sync-required", diff: null };
    if (previous.scopeSignature !== current.scopeSignature || previous.fingerprint !== current.fingerprint) {
        const diff = compareSourceInventories(previous, current);
        return { status: diff.isPossibleDomainSwitch ? "possible-domain-switch" : "source-sync-required", diff };
    }
    return { status: "ready", diff: null };
}

export function isSourceInventory(value: unknown): value is SourceInventoryV1 {
    if (!isRecord(value)
        || value.schemaVersion !== SOURCE_INVENTORY_SCHEMA_VERSION
        || typeof value.scopeSignature !== "string"
        || typeof value.fingerprint !== "string"
        || !Number.isFinite(value.generatedAt)
        || !Array.isArray(value.files)) return false;
    return value.files.every((file) => isRecord(file)
        && typeof file.path === "string"
        && file.path.trim().length > 0
        && isNonNegativeFiniteNumber(file.size)
        && isNonNegativeFiniteNumber(file.modifiedAt));
}

function normalizeFiles(files: readonly SourceInventoryFile[]): SourceInventoryFile[] {
    const normalized = new Map<string, SourceInventoryFile>();
    for (const file of files) {
        const path = file.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        if (!path) continue;
        normalized.set(path, { path, size: normalizeSize(file.size), modifiedAt: normalizeTimestamp(file.modifiedAt) });
    }
    return Array.from(normalized.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function fingerprint(scopeSignature: string, files: readonly SourceInventoryFile[]): string {
    const source = [scopeSignature, ...files.map((file) => `${file.path}\u0000${file.size}\u0000${file.modifiedAt}`)].join("\u0001");
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `inventory-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeSize(value: number): number {
    return isNonNegativeFiniteNumber(value) ? Math.floor(value) : 0;
}

function normalizeTimestamp(value: number): number {
    return isNonNegativeFiniteNumber(value) ? Math.floor(value) : 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
