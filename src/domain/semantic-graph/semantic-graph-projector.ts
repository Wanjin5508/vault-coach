import { createManualRelationId, isUndirectedRelation } from "./concept-candidate-fingerprint";
import { normalizeConceptAlias, normalizeConceptAliases } from "./concept-normalizer";
import type {
    EffectiveSemanticGraph,
    EffectiveSemanticRelation,
    ConceptEvidenceRef,
    SemanticAutoRelationPolicy,
    SemanticConcept,
    SemanticGraphState,
    UserSemanticDecision,
} from "./semantic-graph-types";

/** 将不可变模型候选与只追加用户决策投影为有效图。 */
export class SemanticGraphProjector {
    project(state: SemanticGraphState): EffectiveSemanticGraph {
        const activeDecisions = this.getActiveDecisions(state.decisions);
        const redirects = this.buildDecisionRedirects(activeDecisions);
        this.addExactNameRedirects(state.concepts, redirects);
        const resolve = (conceptId: string): string => this.resolveRedirect(conceptId, redirects);
        const aliasesByConcept = this.collectAliases(activeDecisions, resolve);
        const conceptsById = new Map(state.concepts.map((concept) => [concept.id, concept]));
        const membersByCanonicalId = new Map<string, SemanticConcept[]>();
        for (const concept of state.concepts) {
            const canonicalId = resolve(concept.id);
            // 历史合并可能引用已经不存在的来源 Concept。应保留现有非活动行为，
            // 不能凭空创建新的规范节点。
            if (!conceptsById.has(canonicalId)) continue;
            const members = membersByCanonicalId.get(canonicalId) ?? [];
            members.push(concept);
            membersByCanonicalId.set(canonicalId, members);
        }
        const concepts = state.concepts
            .filter((concept) => resolve(concept.id) === concept.id)
            .map((concept) => this.withMergedEvidence(
                concept,
                membersByCanonicalId.get(concept.id) ?? [concept],
                aliasesByConcept.get(concept.id) ?? [],
            ))
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

    /**
     * 从待处理候选中选择仅用于展示的关系。
     *
     * 这些记录不会进入有效图，也不会写入用户决策；拒绝或人工确认始终具有更高优先级。
     */
    projectAutoDisplayRelations(
        state: SemanticGraphState,
        policy: SemanticAutoRelationPolicy,
    ): EffectiveSemanticRelation[] {
        if (!policy.enabled) return [];
        const effective = this.project(state);
        const confirmed = new Set(effective.relations
            .map((relation) => relation.candidateFingerprint)
            .filter((fingerprint): fingerprint is string => fingerprint !== undefined));
        const rejected = new Set(effective.rejectedCandidateFingerprints);
        const conceptIds = new Set(effective.concepts.map((concept) => concept.id));
        const redirects = new Map(Object.entries(effective.redirects));
        return state.candidates
            .filter((candidate) => !confirmed.has(candidate.fingerprint) && !rejected.has(candidate.fingerprint))
            .filter((candidate) => shouldAutoDisplay(candidate.origin, candidate.confidence, policy))
            .map((candidate) => this.toCandidateRelation(candidate, (conceptId) => this.resolveRedirect(conceptId, redirects)))
            .filter((relation): relation is EffectiveSemanticRelation => relation !== null)
            .filter((relation) => conceptIds.has(relation.sourceConceptId) && conceptIds.has(relation.targetConceptId))
            .sort((left, right) => left.id.localeCompare(right.id));
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

    /** 用户治理始终优先于自动展示分组。 */
    private buildDecisionRedirects(decisions: readonly UserSemanticDecision[]): Map<string, string> {
        const redirects = new Map<string, string>();
        for (const decision of decisions) {
            if (decision.kind !== "merge-concepts") continue;
            for (const mergedId of decision.mergedConceptIds) {
                if (mergedId !== decision.canonicalConceptId) redirects.set(mergedId, decision.canonicalConceptId);
            }
        }
        return redirects;
    }

    /**
     * 按 Section 划分的抽取记录保留在存储中，使模型输出和来源可以独立审计。
     * 在有效 Learning Map 中，归一化名称精确相同的记录作为一个展示 Concept，
     * 所有有来源成员共同向该节点提供证据。
     *
     * 该规则有意比相似度或别名匹配更严格。相似或名称不同的 Concept 在用户显式合并前
     * 始终保持独立；名称相同的 Concept 则不能因处理顺序而让后续文件来源消失。
     */
    private addExactNameRedirects(concepts: readonly SemanticConcept[], redirects: Map<string, string>): void {
        const membersByName = new Map<string, SemanticConcept[]>();
        for (const concept of concepts) {
            const resolvedId = this.resolveRedirect(concept.id, redirects);
            // 人工合并已经确定语义身份，不得再按重定向成员原来的来源局部名称重新分组。
            if (resolvedId !== concept.id) continue;
            const members = membersByName.get(concept.normalizedName) ?? [];
            members.push(concept);
            membersByName.set(concept.normalizedName, members);
        }
        for (const members of membersByName.values()) {
            if (members.length < 2) continue;
            const canonicalId = members
                .map((concept) => concept.id)
                .sort((left, right) => left.localeCompare(right))[0];
            if (!canonicalId) continue;
            for (const member of members) {
                if (member.id !== canonicalId) redirects.set(member.id, canonicalId);
            }
        }
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

    /**
     * 用户合并或归一化名称精确匹配，会把多个有来源 Concept 组成一个有效展示节点，
     * 同时保留每个成员的来源。
     *
     * 相似度关系不得调用此路径，因此候选关系不能自动制造证据。
     */
    private withMergedEvidence(
        canonical: SemanticConcept,
        members: readonly SemanticConcept[],
        decisionAliases: readonly string[],
    ): SemanticConcept {
        return {
            ...canonical,
            aliases: normalizeConceptAliases([
                ...members.flatMap((concept) => concept.aliases),
                ...decisionAliases,
            ], canonical.displayName),
            evidence: mergeEvidence(members.flatMap((concept) => concept.evidence)),
            sourceCandidateIds: Array.from(new Set(members.flatMap((concept) => concept.sourceCandidateIds)))
                .sort((left, right) => left.localeCompare(right)),
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

function mergeEvidence(evidence: readonly ConceptEvidenceRef[]): ConceptEvidenceRef[] {
    const byId = new Map<string, ConceptEvidenceRef>();
    for (const item of evidence) {
        const key = `${item.sectionId}\u0000${item.chunkId}\u0000${item.excerptId}`;
        if (!byId.has(key)) byId.set(key, item);
    }
    return Array.from(byId.values())
        .sort((left, right) => evidenceSortKey(left).localeCompare(evidenceSortKey(right)))
        .map((item) => ({ ...item, locator: { ...item.locator } }));
}

function evidenceSortKey(evidence: ConceptEvidenceRef): string {
    const locatorPath = evidence.locator.type === "zotero"
        ? evidence.locator.itemKey
        : evidence.locator.filePath;
    return `${locatorPath}\u0000${evidence.sectionId}\u0000${evidence.chunkId}\u0000${evidence.excerptId}`;
}

function shouldAutoDisplay(
    origin: "model" | "rule" | "similarity",
    confidence: number,
    policy: SemanticAutoRelationPolicy,
): boolean {
    if (origin === "rule") return policy.includeRuleRelations;
    if (origin === "similarity") return policy.includeSimilarityRelations && confidence >= policy.modelMinConfidence;
    return confidence >= policy.modelMinConfidence;
}
