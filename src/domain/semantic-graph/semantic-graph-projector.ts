import { createManualRelationId, isUndirectedRelation } from "./concept-candidate-fingerprint";
import { normalizeConceptAlias, normalizeConceptAliases } from "./concept-normalizer";
import type {
    EffectiveSemanticGraph,
    EffectiveSemanticRelation,
    SemanticConcept,
    SemanticGraphState,
    UserSemanticDecision,
} from "./semantic-graph-types";

/** Projects immutable model candidates plus append-only user decisions into the effective graph. */
export class SemanticGraphProjector {
    project(state: SemanticGraphState): EffectiveSemanticGraph {
        const activeDecisions = this.getActiveDecisions(state.decisions);
        const redirects = this.buildRedirects(activeDecisions);
        const resolve = (conceptId: string): string => this.resolveRedirect(conceptId, redirects);
        const aliasesByConcept = this.collectAliases(activeDecisions, resolve);
        const concepts = state.concepts
            .filter((concept) => resolve(concept.id) === concept.id)
            .map((concept) => this.withDecisionAliases(concept, aliasesByConcept.get(concept.id) ?? []))
            .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
        const candidateDecisions = new Map<string, "confirm" | "reject">();
        for (const decision of activeDecisions) {
            if (decision.kind === "confirm-candidate") candidateDecisions.set(decision.candidateFingerprint, "confirm");
            if (decision.kind === "reject-candidate") candidateDecisions.set(decision.candidateFingerprint, "reject");
        }
        const rejected = new Set(Array.from(candidateDecisions.entries())
            .filter(([, decision]) => decision === "reject")
            .map(([fingerprint]) => fingerprint));
        const confirmed = new Set(Array.from(candidateDecisions.entries())
            .filter(([, decision]) => decision === "confirm")
            .map(([fingerprint]) => fingerprint));
        const relations = state.candidates
            .filter((candidate) => confirmed.has(candidate.fingerprint) && !rejected.has(candidate.fingerprint))
            .map((candidate) => this.toCandidateRelation(candidate, resolve))
            .filter((relation): relation is EffectiveSemanticRelation => relation !== null);
        const removedManualRelations = new Set(activeDecisions
            .filter((decision): decision is Extract<UserSemanticDecision, { kind: "remove-manual-relation" }> => decision.kind === "remove-manual-relation")
            .map((decision) => decision.relationId));
        for (const decision of activeDecisions) {
            if (decision.kind !== "create-manual-relation" || removedManualRelations.has(decision.relationId)) continue;
            const sourceConceptId = resolve(decision.sourceConceptId);
            const targetConceptId = resolve(decision.targetConceptId);
            if (sourceConceptId === targetConceptId) continue;
            const endpoints = isUndirectedRelation(decision.type)
                ? [sourceConceptId, targetConceptId].sort((left, right) => left.localeCompare(right))
                : [sourceConceptId, targetConceptId];
            const source = endpoints[0];
            const target = endpoints[1];
            if (!source || !target) continue;
            relations.push({
                id: decision.relationId || createManualRelationId(decision.type, source, target, decision.id),
                type: decision.type,
                sourceConceptId: source,
                targetConceptId: target,
                confidence: 1,
                origin: "user",
                evidence: [...(decision.evidence ?? [])],
                decisionId: decision.id,
            });
        }
        const relationMap = new Map<string, EffectiveSemanticRelation>();
        for (const relation of relations) relationMap.set(relation.id, relation);
        return {
            concepts,
            relations: Array.from(relationMap.values()).sort((left, right) => left.id.localeCompare(right.id)),
            redirects: Object.fromEntries(Array.from(redirects.entries()).sort(([left], [right]) => left.localeCompare(right))),
            rejectedCandidateFingerprints: Array.from(rejected).sort((left, right) => left.localeCompare(right)),
        };
    }

    private getActiveDecisions(decisions: readonly UserSemanticDecision[]): UserSemanticDecision[] {
        const undoneMergeIds = new Set(decisions
            .filter((decision): decision is Extract<UserSemanticDecision, { kind: "undo-merge" }> => decision.kind === "undo-merge")
            .map((decision) => decision.supersedesDecisionId));
        const undoneCandidateDecisionIds = new Set(decisions
            .filter((decision): decision is Extract<UserSemanticDecision, { kind: "undo-candidate-decision" }> => decision.kind === "undo-candidate-decision")
            .map((decision) => decision.supersedesDecisionId));
        const undoneManualRemovalIds = new Set(decisions
            .filter((decision): decision is Extract<UserSemanticDecision, { kind: "undo-manual-relation-removal" }> => decision.kind === "undo-manual-relation-removal")
            .map((decision) => decision.supersedesDecisionId));
        return decisions.filter((decision) => {
            if (decision.kind === "merge-concepts") return !undoneMergeIds.has(decision.id);
            if (decision.kind === "confirm-candidate" || decision.kind === "reject-candidate") {
                return !undoneCandidateDecisionIds.has(decision.id);
            }
            if (decision.kind === "remove-manual-relation") return !undoneManualRemovalIds.has(decision.id);
            return true;
        });
    }

    private buildRedirects(decisions: readonly UserSemanticDecision[]): Map<string, string> {
        const redirects = new Map<string, string>();
        for (const decision of decisions) {
            if (decision.kind !== "merge-concepts") continue;
            for (const mergedId of decision.mergedConceptIds) {
                if (mergedId !== decision.canonicalConceptId) redirects.set(mergedId, decision.canonicalConceptId);
            }
        }
        return redirects;
    }

    private resolveRedirect(conceptId: string, redirects: ReadonlyMap<string, string>): string {
        const visited = new Set<string>();
        let current = conceptId;
        while (redirects.has(current) && !visited.has(current)) {
            visited.add(current);
            current = redirects.get(current) ?? current;
        }
        return current;
    }

    private collectAliases(decisions: readonly UserSemanticDecision[], resolve: (id: string) => string): Map<string, string[]> {
        const aliases = new Map<string, Map<string, string>>();
        for (const decision of decisions) {
            if (decision.kind !== "add-alias" && decision.kind !== "remove-alias") continue;
            const conceptId = resolve(decision.conceptId);
            const normalized = normalizeConceptAlias(decision.alias);
            if (!normalized) continue;
            const conceptAliases = aliases.get(conceptId) ?? new Map<string, string>();
            if (decision.kind === "add-alias") conceptAliases.set(normalized, decision.alias.trim());
            else conceptAliases.delete(normalized);
            aliases.set(conceptId, conceptAliases);
        }
        return new Map(Array.from(aliases.entries()).map(([conceptId, values]) => [conceptId, Array.from(values.values())]));
    }

    private withDecisionAliases(concept: SemanticConcept, aliases: readonly string[]): SemanticConcept {
        return {
            ...concept,
            aliases: normalizeConceptAliases([...concept.aliases, ...aliases], concept.displayName),
            evidence: concept.evidence.map((evidence) => ({ ...evidence, locator: { ...evidence.locator } })),
            sourceCandidateIds: [...concept.sourceCandidateIds],
        };
    }

    private toCandidateRelation(
        candidate: SemanticGraphState["candidates"][number],
        resolve: (conceptId: string) => string,
    ): EffectiveSemanticRelation | null {
        const sourceConceptId = resolve(candidate.sourceConceptId);
        const targetConceptId = resolve(candidate.targetConceptId);
        if (sourceConceptId === targetConceptId) return null;
        const endpoints = isUndirectedRelation(candidate.type)
            ? [sourceConceptId, targetConceptId].sort((left, right) => left.localeCompare(right))
            : [sourceConceptId, targetConceptId];
        const source = endpoints[0];
        const target = endpoints[1];
        if (!source || !target) return null;
        return {
            id: `relation:${candidate.fingerprint}`,
            type: candidate.type,
            sourceConceptId: source,
            targetConceptId: target,
            confidence: candidate.confidence,
            origin: candidate.origin,
            evidence: candidate.evidence.map((evidence) => ({ ...evidence, locator: { ...evidence.locator } })),
            candidateFingerprint: candidate.fingerprint,
        };
    }
}
