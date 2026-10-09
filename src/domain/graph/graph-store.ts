import type { GraphSnapshotV1 } from "./graph-types";

/** 图事实快照的持久化端口；具体实现必须位于基础设施层。 */
export interface GraphStore {
    load(): Promise<GraphSnapshotV1 | null>;
    save(snapshot: GraphSnapshotV1): Promise<void>;
    clear(): Promise<void>;
}
