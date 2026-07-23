import type { LearningGraphApplicationApi } from "../../app/application-api";
import {
    LEARNING_GRAPH_DEFAULT_MAX_EDGES,
    LEARNING_GRAPH_DEFAULT_MAX_NODES,
    LEARNING_GRAPH_MAX_EDGES,
    LEARNING_GRAPH_MAX_NODES,
    type LearningGraphProjection,
    type LearningGraphQuery,
} from "../../domain/learning-graph/learning-graph-types";
import type { SemanticRelationType } from "../../domain/semantic-graph/semantic-graph-types";

/** Presentation state for the bounded, read-only Learning Map explorer. */
export class LearningMapController {
    private query: LearningGraphQuery = {
        depth: 1,
        maxNodes: LEARNING_GRAPH_DEFAULT_MAX_NODES,
        maxEdges: LEARNING_GRAPH_DEFAULT_MAX_EDGES,
    };
    /**
     * Focus is exploration state, not a destructive filter. Keep a small
     * in-memory history so a user can return to the exact previous bounded
     * projection without retyping their search or losing relation filters.
     */
    private readonly focusHistory: LearningGraphQuery[] = [];

    constructor(private readonly api: LearningGraphApplicationApi) {}

    getProjection(): Promise<LearningGraphProjection> {
        return this.api.getProjection(this.query);
    }

    setSearch(search: string): void {
        this.focusHistory.length = 0;
        this.query = { ...this.query, search: search.trim() || undefined, focusNodeId: undefined };
    }

    getSearch(): string { return this.query.search ?? ""; }

    setFocus(nodeId: string | undefined): void {
        if (nodeId && nodeId !== this.query.focusNodeId) this.focusHistory.push(cloneQuery(this.query));
        this.query = { ...this.query, focusNodeId: nodeId, search: undefined };
    }

    getFocus(): string | undefined { return this.query.focusNodeId; }

    canGoBack(): boolean { return this.focusHistory.length > 0; }

    goBack(): boolean {
        const previous = this.focusHistory.pop();
        if (!previous) return false;
        this.query = previous;
        return true;
    }

    setStructuralContext(includeStructuralContext: boolean): void {
        this.query = { ...this.query, includeStructuralContext };
    }

    hasStructuralContext(): boolean { return this.query.includeStructuralContext === true; }

    setAutomaticRelationsVisible(includeAutomaticRelations: boolean): void {
        this.query = { ...this.query, includeAutomaticRelations };
    }

    hasAutomaticRelationsVisible(): boolean { return this.query.includeAutomaticRelations !== false; }

    setFullGraph(full: boolean): void {
        this.query = {
            ...this.query,
            maxNodes: full ? LEARNING_GRAPH_MAX_NODES : LEARNING_GRAPH_DEFAULT_MAX_NODES,
            maxEdges: full ? LEARNING_GRAPH_MAX_EDGES : LEARNING_GRAPH_DEFAULT_MAX_EDGES,
        };
    }

    isFullGraph(): boolean { return this.query.maxNodes === LEARNING_GRAPH_MAX_NODES; }

    setRelationTypes(relationTypes: readonly SemanticRelationType[]): void {
        this.query = { ...this.query, relationTypes: relationTypes.length > 0 ? [...relationTypes] : undefined };
    }

    getRelationTypes(): readonly SemanticRelationType[] { return this.query.relationTypes ?? []; }

    reset(): void {
        this.focusHistory.length = 0;
        this.query = {
            depth: 1,
            includeStructuralContext: this.query.includeStructuralContext,
            includeAutomaticRelations: this.query.includeAutomaticRelations,
            maxNodes: this.query.maxNodes,
            maxEdges: this.query.maxEdges,
        };
    }
}

function cloneQuery(query: LearningGraphQuery): LearningGraphQuery {
    return {
        ...query,
        relationTypes: query.relationTypes ? [...query.relationTypes] : undefined,
    };
}
