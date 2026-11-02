import { describe, expect, it, vi } from "vitest";
import { IndexLifecycleTrace } from "../../../src/app/observability/index-lifecycle-trace";
import { IndexPerformanceMonitor } from "../../../src/app/observability/index-performance-monitor";

describe("IndexPerformanceMonitor", () => {
    it("records long tasks and heap samples without content-bearing fields", () => {
        const trace = new IndexLifecycleTrace(10, () => 100);
        const disconnect = vi.fn();
        const observerCallback: { emitEntries?: (entries: PerformanceEntry[]) => void } = {};
        const monitor = new IndexPerformanceMonitor(
            trace,
            { memory: { usedJSHeapSize: 12, jsHeapSizeLimit: 100 } } as unknown as Performance,
            (nextCallback) => {
                observerCallback.emitEntries = (entries) => nextCallback(
                    { getEntries: () => entries } as PerformanceObserverEntryList,
                    {} as PerformanceObserver,
                );
                return { observe: vi.fn(), disconnect };
            },
        );
        monitor.start();
        if (!observerCallback.emitEntries) throw new Error("Expected the performance observer callback.");
        observerCallback.emitEntries([{ duration: 55 } as PerformanceEntry]);
        monitor.sampleMemory();
        monitor.dispose();

        expect(trace.getEvents()).toEqual([
            expect.objectContaining({ operation: "main-thread.long-task", durationMs: 55 }),
            expect.objectContaining({ operation: "runtime.memory", metrics: { usedHeapBytes: 12, heapLimitBytes: 100 } }),
        ]);
        expect(disconnect).toHaveBeenCalledOnce();
    });

    it("degrades safely when observation and heap metrics are unavailable", () => {
        const trace = new IndexLifecycleTrace(10, () => 100);
        const disconnect = vi.fn();
        const monitor = new IndexPerformanceMonitor(
            trace,
            {} as Performance,
            () => ({ observe: () => { throw new Error("unsupported"); }, disconnect }),
        );

        expect(() => monitor.start()).not.toThrow();
        expect(() => monitor.sampleMemory()).not.toThrow();
        expect(trace.getEvents()).toEqual([]);
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
