import type { AssessmentConceptBinding } from "../assessment/assessment-types";
import type { LearningGraphConceptCatalog } from "../learning-graph/learning-graph-types";
import type {
    MasteryAssessmentInput,
    MasteryBindingIssue,
    MasteryBindingKind,
} from "./mastery-types";

export interface ResolvedMasteryEvidence {
    input: MasteryAssessmentInput;
    conceptId: string;
    bindingKind: MasteryBindingKind;
}

export interface MasteryBindingResolution {
    resolved: ResolvedMasteryEvidence[];
    issues: MasteryBindingIssue[];
}

/**
 * Resolves only explicit IDs or a unique, normalized exact name/Alias match.
 * It intentionally has no embedding, fuzzy matching, or semantic-candidate
 * dependency: wrong mastery attribution is worse than an unknown concept.
 */
export class MasteryBindingResolver {
    resolve(
        assessments: readonly MasteryAssessmentInput[],
        catalog: LearningGraphConceptCatalog,
    ): MasteryBindingResolution {
        const conceptsById = new Set(catalog.concepts.map((concept) => concept.id));
        const nameMatches = createNameMatches(catalog);
        const chunkMatches = createChunkMatches(catalog);
        const resolved: ResolvedMasteryEvidence[] = [];
        const issues: MasteryBindingIssue[] = [];
        for (const input of assessments) {
            const bindingsById = new Map<string, AssessmentConceptBinding>(
                input.conceptBindings.map((binding) => [binding.id, binding]),
            );
            const resolvedConceptIds = new Set<string>();
            for (const sourceConceptId of input.event.conceptIds) {
                if (conceptsById.has(sourceConceptId)) {
                    if (!resolvedConceptIds.has(sourceConceptId)) {
                        resolved.push({ input, conceptId: sourceConceptId, bindingKind: "direct-concept-id" });
                        resolvedConceptIds.add(sourceConceptId);
                    }
                    continue;
                }
                const binding = bindingsById.get(sourceConceptId);
                if (!binding) {
                    this.resolveBySourceChunks(
                        input,
                        sourceConceptId,
                        chunkMatches,
                        resolvedConceptIds,
                        resolved,
                        issues,
                        { reason: "missing-binding" },
                    );
                    continue;
                }
                const matches = nameMatches.get(normalizeMasteryText(binding.label)) ?? [];
                const conceptIds = Array.from(new Set(matches.map((match) => match.conceptId))).sort((left, right) => left.localeCompare(right));
                if (conceptIds.length === 0) {
                    this.resolveBySourceChunks(
                        input,
                        sourceConceptId,
                        chunkMatches,
                        resolvedConceptIds,
                        resolved,
                        issues,
                        { reason: "unknown-concept" },
                    );
                    continue;
                }
                if (conceptIds.length > 1) {
                    this.resolveBySourceChunks(
                        input,
                        sourceConceptId,
                        chunkMatches,
                        resolvedConceptIds,
                        resolved,
                        issues,
                        { reason: "ambiguous-label", candidateConceptIds: conceptIds },
                    );
                    continue;
                }
                const match = matches.find((item) => item.conceptId === conceptIds[0]);
                const conceptId = conceptIds[0];
                if (match && conceptId && !resolvedConceptIds.has(conceptId)) {
                    resolved.push({ input, conceptId, bindingKind: match.kind });
                    resolvedConceptIds.add(conceptId);
                    continue;
                }
            }
        }
        return {
            resolved: resolved.sort(compareResolved),
            issues: issues.sort(compareIssues),
        };
    }

    /**
     * Legacy Exam events used a provisional topic ID. When that topic cannot
     * be matched exactly, the persisted source chunks are the only safe bridge
     * to the current effective Concept catalog. This never uses fuzzy text or
     * semantic similarity and never attributes evidence outside a question's
     * own source chunks.
     */
    private resolveBySourceChunks(
        input: MasteryAssessmentInput,
        sourceConceptId: string,
        chunkMatches: ReadonlyMap<string, readonly string[]>,
        resolvedConceptIds: Set<string>,
        resolved: ResolvedMasteryEvidence[],
        issues: MasteryBindingIssue[],
        fallbackIssue: Omit<MasteryBindingIssue, "eventId" | "sourceConceptId">,
    ): void {
        const conceptIds = Array.from(new Set(input.event.sourceChunkIds
            .flatMap((chunkId) => chunkMatches.get(chunkId) ?? [])))
            .sort((left, right) => left.localeCompare(right));
        if (conceptIds.length === 0) {
            issues.push({ eventId: input.event.id, sourceConceptId, ...fallbackIssue });
            return;
        }
        for (const conceptId of conceptIds) {
            if (resolvedConceptIds.has(conceptId)) continue;
            resolved.push({ input, conceptId, bindingKind: "source-chunk-evidence" });
            resolvedConceptIds.add(conceptId);
        }
    }
}

interface NameMatch {
    conceptId: string;
    kind: Exclude<MasteryBindingKind, "direct-concept-id" | "source-chunk-evidence">;
}

function createNameMatches(catalog: LearningGraphConceptCatalog): Map<string, NameMatch[]> {
    const matches = new Map<string, NameMatch[]>();
    for (const concept of catalog.concepts) {
        appendMatch(matches, normalizeMasteryText(concept.label), { conceptId: concept.id, kind: "exact-display-name" });
        for (const alias of concept.aliases) {
            appendMatch(matches, normalizeMasteryText(alias), { conceptId: concept.id, kind: "exact-alias" });
        }
    }
    return matches;
}

function createChunkMatches(catalog: LearningGraphConceptCatalog): Map<string, string[]> {
    const matches = new Map<string, string[]>();
    for (const concept of catalog.concepts) {
        for (const chunkId of concept.sourceChunkIds) {
            if (!chunkId) continue;
            const values = matches.get(chunkId) ?? [];
            if (!values.includes(concept.id)) values.push(concept.id);
            matches.set(chunkId, values);
        }
    }
    for (const values of matches.values()) values.sort((left, right) => left.localeCompare(right));
    return matches;
}

function appendMatch(matches: Map<string, NameMatch[]>, key: string, value: NameMatch): void {
    if (!key) return;
    const current = matches.get(key) ?? [];
    if (!current.some((match) => match.conceptId === value.conceptId && match.kind === value.kind)) current.push(value);
    matches.set(key, current);
}

export function normalizeMasteryText(value: unknown): string {
    return typeof value === "string" ? value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase() : "";
}

function compareResolved(left: ResolvedMasteryEvidence, right: ResolvedMasteryEvidence): number {
    return left.conceptId.localeCompare(right.conceptId)
        || left.input.event.occurredAt - right.input.event.occurredAt
        || left.input.event.id.localeCompare(right.input.event.id);
}

function compareIssues(left: MasteryBindingIssue, right: MasteryBindingIssue): number {
    return left.eventId.localeCompare(right.eventId) || left.sourceConceptId.localeCompare(right.sourceConceptId);
}
