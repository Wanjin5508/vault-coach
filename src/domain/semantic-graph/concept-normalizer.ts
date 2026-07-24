/**
 * Conservative normalization defines exact term equality for display-level
 * provenance aggregation. Similarity and merely related aliases never imply a
 * merge without an explicit user decision.
 */
export function normalizeConceptName(value: string): string {
    return value
        .normalize("NFC")
        .trim()
        .toLocaleLowerCase()
        .replace(/[\u2010-\u2015_./·]+/g, " ")
        .replace(/\[|\]/g, " ")
        .replace(/[(){}'"“”‘’`]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function normalizeConceptAlias(value: string): string {
    return normalizeConceptName(value);
}

export function normalizeConceptAliases(values: readonly string[], canonicalName: string): string[] {
    const canonical = normalizeConceptName(canonicalName);
    return Array.from(new Set(values
        .map((value) => value.normalize("NFC").trim())
        .filter((value) => value.length > 0)
        .filter((value) => normalizeConceptAlias(value) !== canonical)))
        .sort((left, right) => left.localeCompare(right));
}
