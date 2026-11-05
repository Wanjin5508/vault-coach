export type IndexTraceOperation =
    | "core-index.rebuild"
    | "core-index.sync"
    | "text.persist"
    | "core.activate"
    | "vector-job.run"
    | "embedding.batch"
    | "rerank.batch"
    | "vector.activate"
    | "graph-job.run"
    | "graph.snapshot"
    | "concept.extract"
    | "concept.embed"
    | "graph.activate"
    | "main-thread.long-task"
    | "runtime.memory";

export type IndexTraceStatus = "started" | "checkpoint" | "completed" | "failed" | "cancelled" | "suspended" | "stale" | "superseded";

export interface IndexTraceCounts {
    total?: number;
    processed?: number;
    failed?: number;
    queued?: number;
}

export interface IndexTraceContext {
    jobRef?: string;
    generationRef?: string;
    policyRef?: string;
    role?: "core" | "vector" | "graph" | "embedding" | "reranker" | "utility";
    counts?: IndexTraceCounts;
    metrics?: {
        usedHeapBytes?: number;
        heapLimitBytes?: number;
    };
}

export interface IndexLifecycleTraceEvent extends IndexTraceContext {
    schemaVersion: 1;
    sequence: number;
    operation: IndexTraceOperation;
    status: IndexTraceStatus;
    timestamp: number;
    durationMs: number | null;
    errorCode: string | null;
}

export interface IndexTraceSpan {
    checkpoint(counts: IndexTraceCounts): void;
    finish(status?: Exclude<IndexTraceStatus, "started" | "checkpoint">, errorCode?: string | null, counts?: IndexTraceCounts): void;
}

/**
 * 仅保留无正文、无路径的有界内存 trace。它不写磁盘、不访问网络，也不替代真机性能采样。
 */
export class IndexLifecycleTrace {
    private sequence = 0;
    private readonly events: IndexLifecycleTraceEvent[] = [];

    constructor(
        private readonly limit: number = 256,
        private readonly now: () => number = () => performance.now(),
    ) {}

    begin(operation: IndexTraceOperation, context: IndexTraceContext = {}): IndexTraceSpan {
        const startedAt = this.now();
        let finished = false;
        this.push({ operation, status: "started", timestamp: startedAt, durationMs: null, errorCode: null, ...cloneContext(context) });
        return {
            checkpoint: (counts) => {
                if (finished) return;
                this.push({
                    operation,
                    status: "checkpoint",
                    timestamp: this.now(),
                    durationMs: null,
                    errorCode: null,
                    ...cloneContext({ ...context, counts }),
                });
            },
            finish: (status = "completed", errorCode = null, counts) => {
                if (finished) return;
                finished = true;
                const finishedAt = this.now();
                this.push({
                    operation,
                    status,
                    timestamp: finishedAt,
                    durationMs: Math.max(0, finishedAt - startedAt),
                    errorCode,
                    ...cloneContext({ ...context, ...(counts ? { counts } : {}) }),
                });
            },
        };
    }

    instant(operation: IndexTraceOperation, context: IndexTraceContext = {}): void {
        this.push({
            operation,
            status: "completed",
            timestamp: this.now(),
            durationMs: 0,
            errorCode: null,
            ...cloneContext(context),
        });
    }

    measurement(operation: IndexTraceOperation, durationMs: number, context: IndexTraceContext = {}): void {
        this.push({
            operation,
            status: "completed",
            timestamp: this.now(),
            durationMs: Math.max(0, durationMs),
            errorCode: null,
            ...cloneContext(context),
        });
    }

    getEvents(): IndexLifecycleTraceEvent[] {
        return this.events.map(cloneEvent);
    }

    clear(): void {
        this.events.splice(0);
    }

    private push(event: Omit<IndexLifecycleTraceEvent, "schemaVersion" | "sequence">): void {
        this.events.push({ schemaVersion: 1, sequence: ++this.sequence, ...event });
        if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    }
}

/** 原始 generation/policy/job 身份只进入不可逆短摘要，避免 endpoint/model/path 泄漏到诊断。 */
export function createIndexTraceRef(kind: "job" | "generation" | "policy", rawIdentity: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < rawIdentity.length; index += 1) {
        hash ^= rawIdentity.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${kind}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function cloneContext(context: IndexTraceContext): IndexTraceContext {
    return {
        ...context,
        ...(context.counts ? { counts: { ...context.counts } } : {}),
        ...(context.metrics ? { metrics: { ...context.metrics } } : {}),
    };
}

function cloneEvent(event: IndexLifecycleTraceEvent): IndexLifecycleTraceEvent {
    return {
        ...event,
        ...(event.counts ? { counts: { ...event.counts } } : {}),
        ...(event.metrics ? { metrics: { ...event.metrics } } : {}),
    };
}
