import type { SemanticGraphState } from "./semantic-graph-types";

/** 持久化端口；JSON 分片属于基础设施实现细节。 */
export interface SemanticGraphStore {
    load(): Promise<SemanticGraphState | null>;
    save(state: SemanticGraphState): Promise<void>;
    clear(): Promise<void>;
}
