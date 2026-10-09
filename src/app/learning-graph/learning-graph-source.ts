import type { GraphSnapshotV1 } from "../../domain/graph/graph-types";
import type { EffectiveSemanticGraph } from "../../domain/semantic-graph/semantic-graph-types";
import type { KnowledgeGraphService } from "../graph/knowledge-graph-service";
import type { SemanticGraphService } from "../semantic-graph/semantic-graph-service";

/** LearningGraph 读取端口；调用方不得绕过它访问 JSON 存储或 Obsidian 缓存。 */
export interface LearningGraphSource {
    getStructuralSnapshot(): GraphSnapshotV1 | null;
    getEffectiveSemanticGraph(): EffectiveSemanticGraph;
    getAutoDisplayRelations(): EffectiveSemanticGraph["relations"];
    /**
     * 版本范围同时覆盖持久化关系决策和仅展示策略。
     * 查询缓存不得隐藏刚确认的关系或刚发生的设置变更。
     */
    getLearningMapRevision(): string;
}

/** 将结构图和语义图服务组合为 LearningGraph 的只读来源适配器。 */
export class ServiceLearningGraphSource implements LearningGraphSource {
    constructor(
        private readonly structuralGraph: KnowledgeGraphService,
        private readonly semanticGraph: SemanticGraphService,
    ) {}

    getStructuralSnapshot(): GraphSnapshotV1 | null {
        return this.structuralGraph.getSnapshot();
    }

    getEffectiveSemanticGraph(): EffectiveSemanticGraph {
        return this.semanticGraph.getEffectiveGraph();
    }

    getAutoDisplayRelations(): EffectiveSemanticGraph["relations"] {
        return this.semanticGraph.getAutoDisplayRelations();
    }

    getLearningMapRevision(): string {
        return this.semanticGraph.getLearningMapRevision();
    }
}
