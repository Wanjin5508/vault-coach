export type LocalAiPriority = "foreground-query" | "exam" | "explicit-vector" | "background-graph";

const PRIORITY_RANK: Record<LocalAiPriority, number> = {
    "foreground-query": 0,
    exam: 1,
    "explicit-vector": 2,
    "background-graph": 3,
};

interface ScheduledTask<T> {
    id: number;
    priority: LocalAiPriority;
    signal?: AbortSignal;
    run(): Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
    detachAbort(): void;
}

/** 单活跃模型调度器。任务只在 batch 边界切换，前台请求可越过尚未开始的后台 batch。 */
export class LocalAiScheduler {
    private sequence = 0;
    private active = false;
    private disposed = false;
    private readonly queue: ScheduledTask<unknown>[] = [];

    schedule<T>(priority: LocalAiPriority, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (this.disposed) return Promise.reject(new Error("Local AI scheduler disposed."));
        if (signal?.aborted) return Promise.reject(createAbortError());
        return new Promise<T>((resolve, reject) => {
            const id = ++this.sequence;
            const abort = () => {
                const index = this.queue.findIndex((task) => task.id === id);
                if (index < 0) return;
                const [removed] = this.queue.splice(index, 1);
                removed?.detachAbort();
                reject(createAbortError());
            };
            const task: ScheduledTask<T> = {
                id,
                priority,
                signal,
                run,
                resolve,
                reject,
                detachAbort: () => signal?.removeEventListener("abort", abort),
            };
            signal?.addEventListener("abort", abort, { once: true });
            this.queue.push(task as ScheduledTask<unknown>);
            this.queue.sort(compareTasks);
            this.drain();
        });
    }

    dispose(): void {
        this.disposed = true;
        this.cancelPending(new Error("Local AI scheduler disposed."));
    }

    cancelPending(reason: Error = createAbortError()): void {
        for (const task of this.queue.splice(0)) {
            task.detachAbort();
            task.reject(reason);
        }
    }

    private drain(): void {
        if (this.active || this.disposed) return;
        const task = this.queue.shift();
        if (!task) return;
        task.detachAbort();
        if (task.signal?.aborted) {
            task.reject(createAbortError());
            this.drain();
            return;
        }
        this.active = true;
        void task.run().then(
            (value) => task.resolve(value),
            (reason: unknown) => task.reject(reason),
        ).finally(() => {
            this.active = false;
            this.drain();
        });
    }
}

function compareTasks(left: ScheduledTask<unknown>, right: ScheduledTask<unknown>): number {
    return PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] || left.id - right.id;
}

function createAbortError(): DOMException {
    return new DOMException("Local AI request aborted.", "AbortError");
}
