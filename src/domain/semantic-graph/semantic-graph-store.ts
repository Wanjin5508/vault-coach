import type { SemanticGraphState } from "./semantic-graph-types";

/** Persistence port. JSON shards are an implementation detail of infrastructure. */
export interface SemanticGraphStore {
    load(): Promise<SemanticGraphState | null>;
    save(state: SemanticGraphState): Promise<void>;
    clear(): Promise<void>;
}
