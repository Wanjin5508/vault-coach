import type { SemanticGraphApplicationApi } from "../../app/application-api";
import type {
    ConceptReviewProjection,
    ConceptReviewQuery,
    SemanticRelationType,
} from "../../domain/semantic-graph/semantic-graph-types";

/** 局部、有界 Concept 审查投影的展示层状态。 */
export class ConceptReviewController {
    /** 画布只渲染局部图，不得成为完整 Vault 图渲染器。 */
    private query: ConceptReviewQuery = { includePending: true, limit: 36 };

    constructor(private readonly api: SemanticGraphApplicationApi) {}

    getState() {
        return this.api.getState();
    }

    async getProjection(): Promise<ConceptReviewProjection> {
        return this.api.getReviewProjection(this.query);
    }

    setSearch(search: string): void {
        this.query = { ...this.query, search: search.trim() || undefined };
    }

    getSearch(): string { return this.query.search ?? ""; }

    isPendingVisible(): boolean { return this.query.includePending !== false; }

    setPendingVisible(includePending: boolean): void {
        this.query = { ...this.query, includePending };
    }

    focusConcept(conceptId: string | undefined): void {
        this.query = { ...this.query, conceptId };
    }

    rebuild(): Promise<void> { return this.api.rebuild(); }
    abort(): void { this.api.abort(); }
    confirm(fingerprint: string): Promise<void> { return this.api.confirmCandidate(fingerprint); }
    reject(fingerprint: string, reason?: string): Promise<void> { return this.api.rejectCandidate(fingerprint, reason); }
    undoCandidateDecision(decisionId: string): Promise<void> { return this.api.undoCandidateDecision(decisionId); }
    merge(canonicalConceptId: string, mergedConceptIds: readonly string[]): Promise<void> { return this.api.mergeConcepts(canonicalConceptId, mergedConceptIds); }
    undoMerge(decisionId: string): Promise<void> { return this.api.undoMerge(decisionId); }
    addAlias(conceptId: string, alias: string): Promise<void> { return this.api.addAlias(conceptId, alias); }
    removeAlias(conceptId: string, alias: string): Promise<void> { return this.api.removeAlias(conceptId, alias); }
    createManualRelation(type: SemanticRelationType, source: string, target: string, note: string): Promise<void> {
        return this.api.createManualRelation(type, source, target, undefined, note);
    }
    removeManualRelation(relationId: string): Promise<void> { return this.api.removeManualRelation(relationId); }
    undoManualRelationRemoval(decisionId: string): Promise<void> { return this.api.undoManualRelationRemoval(decisionId); }
}
