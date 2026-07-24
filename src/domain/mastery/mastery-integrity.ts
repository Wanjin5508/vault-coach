import { MASTERY_SNAPSHOT_SCHEMA_VERSION, type MasterySnapshotV1 } from "./mastery-types";

export interface MasteryIntegrityReport {
    valid: boolean;
    issues: string[];
}

/** Lightweight invariant checks before a derived snapshot reaches disk. */
export class MasteryIntegrityService {
    check(snapshot: MasterySnapshotV1): MasteryIntegrityReport {
        const issues: string[] = [];
        if (snapshot.schemaVersion !== MASTERY_SNAPSHOT_SCHEMA_VERSION) issues.push("unsupported-schema");
        if (!snapshot.algorithmVersion || !Number.isFinite(snapshot.calculatedAt)) issues.push("invalid-metadata");
        const conceptIds = new Set<string>();
        for (const state of snapshot.states) {
            if (conceptIds.has(state.conceptId)) issues.push(`duplicate-concept:${state.conceptId}`);
            conceptIds.add(state.conceptId);
            if (state.masteryScore !== null && (state.masteryScore < 0 || state.masteryScore > 1)) issues.push(`invalid-score:${state.conceptId}`);
            if (state.confidence < 0 || state.confidence > 1) issues.push(`invalid-confidence:${state.conceptId}`);
            if (state.level === "unknown" && state.masteryScore !== null) issues.push(`unknown-has-score:${state.conceptId}`);
        }
        if (!isSorted(snapshot.states.map((state) => state.conceptId))) issues.push("unsorted-states");
        return { valid: issues.length === 0, issues };
    }
}

function isSorted(values: readonly string[]): boolean {
    return values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) <= 0);
}
