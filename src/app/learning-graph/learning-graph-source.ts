import type { GraphSnapshotV1 } from "../../domain/graph/graph-types";
import type { EffectiveSemanticGraph } from "../../domain/semantic-graph/semantic-graph-types";
import type { KnowledgeGraphService } from "../graph/knowledge-graph-service";
import type { SemanticGraphService } from "../semantic-graph/semantic-graph-service";

/** Read port: LearningGraph never reaches into a JSON store or Obsidian cache. */
export interface LearningGraphSource {
    getStructuralSnapshot(): GraphSnapshotV1 | null;
    getEffectiveSemanticGraph(): EffectiveSemanticGraph;
    getAutoDisplayRelations(): EffectiveSemanticGraph["relations"];
    /**
     * Covers persisted relation decisions and the display-only policy.  Query
     * caching must never hide a just-confirmed relation or a settings change.
     */
    getLearningMapRevision(): string;
}

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
