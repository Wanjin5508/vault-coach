import { describe, expect, it } from "vitest";
import { LocalAiScheduler } from "../../../src/app/local-ai/local-ai-scheduler";

describe("LocalAiScheduler", () => {
    it("lets a foreground query overtake queued background batches", async () => {
        const scheduler = new LocalAiScheduler();
        const first = createDeferred<void>();
        const order: string[] = [];
        const running = scheduler.schedule("explicit-vector", async () => {
            order.push("batch-1");
            await first.promise;
        });
        const background = scheduler.schedule("explicit-vector", async () => { order.push("batch-2"); });
        const foreground = scheduler.schedule("foreground-query", async () => { order.push("query"); });

        first.resolve();
        await Promise.all([running, background, foreground]);

        expect(order).toEqual(["batch-1", "query", "batch-2"]);
        scheduler.dispose();
    });

    it("removes an aborted queued task before it starts", async () => {
        const scheduler = new LocalAiScheduler();
        const first = createDeferred<void>();
        let started = false;
        const running = scheduler.schedule("explicit-vector", () => first.promise);
        const controller = new AbortController();
        const queued = scheduler.schedule("background-graph", async () => { started = true; }, controller.signal);
        controller.abort();

        await expect(queued).rejects.toMatchObject({ name: "AbortError" });
        first.resolve();
        await running;
        expect(started).toBe(false);
        scheduler.dispose();
    });

    it("rejects every queued task on hard cancellation without disposing future scheduling", async () => {
        const scheduler = new LocalAiScheduler();
        const active = createDeferred<void>();
        const running = scheduler.schedule("explicit-vector", () => active.promise);
        const queued = scheduler.schedule("background-graph", async () => undefined);

        scheduler.cancelPending();

        await expect(queued).rejects.toMatchObject({ name: "AbortError" });
        active.resolve();
        await running;
        await expect(scheduler.schedule("foreground-query", async () => "ready")).resolves.toBe("ready");
        scheduler.dispose();
    });
});

function createDeferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve: (value?: T) => resolve(value as T) };
}
