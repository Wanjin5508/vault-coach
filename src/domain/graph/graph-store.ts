import type { GraphSnapshotV1 } from "./graph-types";

/** Persistence port for the graph fact snapshot; implementations belong in infrastructure. */
export interface GraphStore {
    load(): Promise<GraphSnapshotV1 | null>;
    save(snapshot: GraphSnapshotV1): Promise<void>;
    clear(): Promise<void>;
}
