import { stableGraphHash } from "../graph/graph-id";
import type { AdaptiveExamPlanningInput, AdaptiveExamRevisions } from "./adaptive-exam-types";

/** Stable JSON without relying on insertion order or host crypto APIs. */
export function canonicalSerialize(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonicalSerialize(item)).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort((left, right) => left.localeCompare(right)).map((key) => {
        return `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`;
    }).join(",")}}`;
}

export function createAdaptiveRevisionFingerprint(
    scopeSignature: string,
    revisions: AdaptiveExamRevisions,
): string {
    return stableGraphHash(canonicalSerialize({ scopeSignature, revisions }));
}

export function createAdaptivePlanInputFingerprint(input: AdaptiveExamPlanningInput): string {
    return stableGraphHash(canonicalSerialize({
        algorithmVersion: input.algorithmVersion,
        planningAt: input.planningAt,
        scope: {
            signature: input.scope.signature,
            eligibleChunkIds: [...input.scope.eligibleChunkIds].sort((left, right) => left.localeCompare(right)),
        },
        examMode: input.examMode,
        targetMode: input.targetMode,
        requestedQuestionCount: input.requestedQuestionCount,
        revisions: input.revisions,
        concepts: input.concepts.map((concept) => ({
            ...concept,
            sourceChunkIds: [...concept.sourceChunkIds].sort((left, right) => left.localeCompare(right)),
        })).sort((left, right) => left.id.localeCompare(right.id)),
        confirmedPrerequisites: input.confirmedPrerequisites
            .map((relation) => ({ ...relation }))
            .sort((left, right) => left.relationId.localeCompare(right.relationId)),
    }));
}
