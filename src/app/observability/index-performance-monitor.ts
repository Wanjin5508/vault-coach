import { IndexLifecycleTrace } from "./index-lifecycle-trace";

interface PerformanceMemorySnapshot {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
}

type ObserverFactory = (callback: PerformanceObserverCallback) => Pick<PerformanceObserver, "observe" | "disconnect">;

/** Chromium 可用时采集 Long Task 和 JS heap；不支持的 Obsidian 平台明确降级为空采样。 */
export class IndexPerformanceMonitor {
    private observer: Pick<PerformanceObserver, "observe" | "disconnect"> | null = null;

    constructor(
        private readonly trace: IndexLifecycleTrace,
        private readonly performanceSource: Performance = performance,
        private readonly observerFactory: ObserverFactory | null = typeof PerformanceObserver === "undefined"
            ? null
            : (callback) => new PerformanceObserver(callback),
    ) {}

    start(): void {
        if (this.observer || !this.observerFactory) return;
        const observer = this.observerFactory((list) => {
            for (const entry of list.getEntries()) {
                this.trace.measurement("main-thread.long-task", entry.duration, { role: "utility" });
            }
        });
        try {
            observer.observe({ type: "longtask", buffered: true });
            this.observer = observer;
        } catch {
            observer.disconnect();
        }
    }

    sampleMemory(): void {
        const memory = (this.performanceSource as Performance & { memory?: Partial<PerformanceMemorySnapshot> }).memory;
        if (!memory || !isFiniteCount(memory.usedJSHeapSize) || !isFiniteCount(memory.jsHeapSizeLimit)) return;
        this.trace.measurement("runtime.memory", 0, {
            role: "utility",
            metrics: {
                usedHeapBytes: memory.usedJSHeapSize,
                heapLimitBytes: memory.jsHeapSizeLimit,
            },
        });
    }

    dispose(): void {
        this.observer?.disconnect();
        this.observer = null;
    }
}

function isFiniteCount(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
