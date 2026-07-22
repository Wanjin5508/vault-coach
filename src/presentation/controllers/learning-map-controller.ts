import type { LearningGraphApplicationApi } from "../../app/application-api";
import type { LearningGraphProjection, LearningGraphQuery } from "../../domain/learning-graph/learning-graph-types";
import type { SemanticRelationType } from "../../domain/semantic-graph/semantic-graph-types";

/** Presentation state for the bounded, read-only Learning Map explorer. */
export class LearningMapController {
    private query: LearningGraphQuery = { depth: 1 };

    constructor(private readonly api: LearningGraphApplicationApi) {}

    getProjection(): Promise<LearningGraphProjection> {
        return this.api.getProjection(this.query);
    }

    setSearch(search: string): void {
        this.query = { ...this.query, search: search.trim() || undefined, focusNodeId: undefined };
    }

    getSearch(): string { return this.query.search ?? ""; }

    setFocus(nodeId: string | undefined): void {
        this.query = { ...this.query, focusNodeId: nodeId, search: undefined };
    }

    getFocus(): string | undefined { return this.query.focusNodeId; }

    setStructuralContext(includeStructuralContext: boolean): void {
        this.query = { ...this.query, includeStructuralContext };
    }

    hasStructuralContext(): boolean { return this.query.includeStructuralContext === true; }

    setRelationTypes(relationTypes: readonly SemanticRelationType[]): void {
        this.query = { ...this.query, relationTypes: relationTypes.length > 0 ? [...relationTypes] : undefined };
    }

    getRelationTypes(): readonly SemanticRelationType[] { return this.query.relationTypes ?? []; }

    reset(): void {
        this.query = { depth: 1, includeStructuralContext: this.query.includeStructuralContext };
    }
}
