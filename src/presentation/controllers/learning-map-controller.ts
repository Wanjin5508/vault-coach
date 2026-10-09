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

const LEARNING_MAP_VIEW_STATE_VERSION = 1 as const;
const SEMANTIC_RELATION_TYPES: readonly SemanticRelationType[] = [
    "same_as", "part_of", "prerequisite_of", "used_for", "contrasts_with", "related_to",
];

export interface LearningMapControllerState {
    version: typeof LEARNING_MAP_VIEW_STATE_VERSION;
    query: LearningGraphQuery;
    focusHistory: LearningGraphQuery[];
}

/** 有界、只读 Learning Map 浏览器的展示状态。 */
export class LearningMapController {
    private query: LearningGraphQuery = {
        depth: 1,
        // 渲染器和查询服务共同执行本地 500 节点/2,000 边硬上限。默认优先显示有界完整图，
        // 避免普通 Vault 被静默拆成总览和隐藏节点。
        maxNodes: LEARNING_GRAPH_MAX_NODES,
        maxEdges: LEARNING_GRAPH_MAX_EDGES,
    };
    /**
     * Focus 是探索状态，不是破坏性过滤。
     *
     * 保留小型内存历史，使用户无需重新输入搜索或丢失关系过滤，即可返回上一个有界投影。
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

    /** 可序列化的叶片局部浏览状态；其中不得包含图事实。 */
    getViewState(): LearningMapControllerState {
        return {
            version: LEARNING_MAP_VIEW_STATE_VERSION,
            query: cloneQuery(this.query),
            focusHistory: this.focusHistory.map(cloneQuery),
        };
    }

    /** 忽略畸形或过期工作区状态，避免导致叶片视图失效。 */
    restoreViewState(value: unknown): void {
        if (!isRecord(value) || value.version !== LEARNING_MAP_VIEW_STATE_VERSION) return;
        const query = sanitizeQuery(value.query);
        if (!query) return;
        const history = Array.isArray(value.focusHistory)
            ? value.focusHistory.map(sanitizeQuery).filter((item): item is LearningGraphQuery => item !== null).slice(-8)
            : [];
        this.query = query;
        this.focusHistory.length = 0;
        this.focusHistory.push(...history);
    }

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

function sanitizeQuery(value: unknown): LearningGraphQuery | null {
    if (!isRecord(value)) return null;
    const depth = value.depth === 0 || value.depth === 1 || value.depth === 2 ? value.depth : 1;
    const relationTypes = Array.isArray(value.relationTypes)
        ? value.relationTypes.filter((type): type is SemanticRelationType => typeof type === "string" && SEMANTIC_RELATION_TYPES.includes(type as SemanticRelationType))
        : [];
    const full = value.maxNodes !== LEARNING_GRAPH_DEFAULT_MAX_NODES || value.maxEdges !== LEARNING_GRAPH_DEFAULT_MAX_EDGES;
    return {
        depth,
        search: optionalText(value.search),
        focusNodeId: optionalText(value.focusNodeId),
        includeStructuralContext: value.includeStructuralContext === true || undefined,
        includeAutomaticRelations: value.includeAutomaticRelations === false ? false : undefined,
        relationTypes: relationTypes.length > 0 ? relationTypes : undefined,
        maxNodes: full ? LEARNING_GRAPH_MAX_NODES : LEARNING_GRAPH_DEFAULT_MAX_NODES,
        maxEdges: full ? LEARNING_GRAPH_MAX_EDGES : LEARNING_GRAPH_DEFAULT_MAX_EDGES,
    };
}

function optionalText(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
