import { isUndirectedRelation } from "./concept-candidate-fingerprint";
import {
    SEMANTIC_GRAPH_SCHEMA_VERSION,
    type ConceptEvidenceRef,
    type SemanticCandidate,
    type SemanticConcept,
    type SemanticGraphState,
    type UserSemanticDecision,
} from "./semantic-graph-types";

export interface SemanticGraphIntegrityIssue {
    code: string;
    message: string;
}

export interface SemanticGraphIntegrityReport {
    valid: boolean;
    issues: SemanticGraphIntegrityIssue[];
}

export class SemanticGraphIntegrityService {
    check(state: SemanticGraphState): SemanticGraphIntegrityReport {
        const issues: SemanticGraphIntegrityIssue[] = [];
        if (state.schemaVersion !== SEMANTIC_GRAPH_SCHEMA_VERSION) {
            issues.push({ code: "unsupported-schema", message: "语义图谱 schema 版本不受支持。" });
        }
        this.checkUniqueIds(state.concepts, (item) => item.id, "duplicate-concept", issues);
        this.checkUniqueIds(state.candidates, (item) => item.fingerprint, "duplicate-candidate", issues);
        this.checkUniqueIds(state.decisions, (item) => item.id, "duplicate-decision", issues);
        const conceptIds = new Set(state.concepts.map((concept) => concept.id));
        for (const concept of state.concepts) this.checkConcept(concept, issues);
        for (const candidate of state.candidates) this.checkCandidate(candidate, conceptIds, issues);
        this.checkDecisions(state.decisions, conceptIds, issues);
        return { valid: issues.length === 0, issues };
    }

    private checkConcept(concept: SemanticConcept, issues: SemanticGraphIntegrityIssue[]): void {
        if (!concept.id.startsWith("concept:") || concept.normalizedName.length === 0 || concept.evidence.length === 0) {
            issues.push({ code: "invalid-concept", message: `概念 ${concept.id} 缺少稳定 ID、名称或真实证据。` });
        }
        this.checkEvidence(concept.evidence, `概念 ${concept.id}`, issues);
    }

    private checkCandidate(candidate: SemanticCandidate, conceptIds: ReadonlySet<string>, issues: SemanticGraphIntegrityIssue[]): void {
        if (!conceptIds.has(candidate.sourceConceptId) || !conceptIds.has(candidate.targetConceptId)) {
            issues.push({ code: "dangling-candidate", message: `候选 ${candidate.fingerprint} 指向不存在的概念。` });
        }
        if (candidate.sourceConceptId === candidate.targetConceptId) {
            issues.push({ code: "self-candidate", message: `候选 ${candidate.fingerprint} 不能连接自身。` });
        }
        if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
            issues.push({ code: "invalid-candidate-confidence", message: `候选 ${candidate.fingerprint} 的置信度无效。` });
        }
        if (candidate.origin === "model" && candidate.evidence.length === 0) {
            issues.push({ code: "model-candidate-without-evidence", message: `模型候选 ${candidate.fingerprint} 缺少 Chunk 证据。` });
        }
        this.checkEvidence(candidate.evidence, `候选 ${candidate.fingerprint}`, issues);
        if (isUndirectedRelation(candidate.type) && candidate.sourceConceptId.localeCompare(candidate.targetConceptId) > 0) {
            issues.push({ code: "unsorted-undirected-candidate", message: `无向候选 ${candidate.fingerprint} 的端点顺序不稳定。` });
        }
    }

    private checkDecisions(decisions: readonly UserSemanticDecision[], conceptIds: ReadonlySet<string>, issues: SemanticGraphIntegrityIssue[]): void {
        const mergeById = new Map(decisions.filter((decision) => decision.kind === "merge-concepts").map((decision) => [decision.id, decision]));
        const candidateDecisionById = new Map(decisions
            .filter((decision) => decision.kind === "confirm-candidate" || decision.kind === "reject-candidate")
            .map((decision) => [decision.id, decision]));
        const manualRemovalById = new Map(decisions
            .filter((decision) => decision.kind === "remove-manual-relation")
            .map((decision) => [decision.id, decision]));
        const redirects = new Map<string, string>();
        for (const decision of decisions) {
            if (decision.kind === "merge-concepts") {
                // Decisions are an append-only user audit trail. A source can be
                // removed later, so historical decisions may reference a concept
                // that no longer has evidence; projection simply leaves it inactive.
                for (const mergedId of decision.mergedConceptIds) redirects.set(mergedId, decision.canonicalConceptId);
            }
            if (decision.kind === "undo-merge" && !mergeById.has(decision.supersedesDecisionId)) {
                issues.push({ code: "invalid-undo-merge", message: `撤销合并 ${decision.id} 未引用有效合并决策。` });
            }
            if (decision.kind === "undo-candidate-decision" && !candidateDecisionById.has(decision.supersedesDecisionId)) {
                issues.push({ code: "invalid-undo-candidate", message: `撤销候选决策 ${decision.id} 未引用确认或拒绝决策。` });
            }
            if (decision.kind === "undo-manual-relation-removal" && !manualRemovalById.has(decision.supersedesDecisionId)) {
                issues.push({ code: "invalid-undo-manual-relation-removal", message: `恢复手工关系 ${decision.id} 未引用有效删除决策。` });
            }
        }
        for (const start of redirects.keys()) {
            const visited = new Set<string>();
            let current: string | undefined = start;
            while (current) {
                if (visited.has(current)) {
                    issues.push({ code: "redirect-cycle", message: `Concept redirect 出现环：${start}` });
                    break;
                }
                visited.add(current);
                current = redirects.get(current);
            }
        }
    }

    private checkEvidence(evidence: readonly ConceptEvidenceRef[], owner: string, issues: SemanticGraphIntegrityIssue[]): void {
        for (const item of evidence) {
            if (!item.sectionId || !item.chunkId || !item.excerptId || !item.inputHash || !item.locator || item.textPreview.length === 0) {
                issues.push({ code: "invalid-evidence", message: `${owner} 包含无效的 Section/Chunk 证据。` });
                return;
            }
        }
    }

    private checkUniqueIds<T>(items: readonly T[], select: (item: T) => string, code: string, issues: SemanticGraphIntegrityIssue[]): void {
        const ids = new Set<string>();
        for (const item of items) {
            const id = select(item);
            if (ids.has(id)) issues.push({ code, message: `语义图谱重复标识：${id}` });
            ids.add(id);
        }
    }
}
