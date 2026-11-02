import { describe, expect, it } from "vitest";
import {
    IndexLifecycleTrace,
    createIndexTraceRef,
} from "../../../src/app/observability/index-lifecycle-trace";

describe("IndexLifecycleTrace", () => {
    it("records bounded, clone-safe spans with deterministic durations", () => {
        const clock = createClock([10, 12, 18, 20, 24]);
        const trace = new IndexLifecycleTrace(3, clock);
        const span = trace.begin("vector-job.run", {
            jobRef: "job:one",
            role: "vector",
        });
        span.checkpoint({ total: 4, processed: 2, queued: 2 });
        span.finish("completed", null, { total: 4, processed: 4, queued: 0 });
        trace.instant("vector.activate", { generationRef: "generation:one" });

        const events = trace.getEvents();
        expect(events).toHaveLength(3);
        expect(events.map((event) => event.status)).toEqual(["checkpoint", "completed", "completed"]);
        expect(events[1]).toMatchObject({ operation: "vector-job.run", durationMs: 8 });
        events[0]!.counts!.processed = 99;
        expect(trace.getEvents()[0]?.counts?.processed).toBe(2);
    });

    it("hashes raw policy and generation identities before they enter diagnostics", () => {
        const rawPolicy = "ollama\u0000http://127.0.0.1:11434\u0000private-model";
        const rawGeneration = "core-v1:private-vault-fingerprint";

        const policyRef = createIndexTraceRef("policy", rawPolicy);
        const generationRef = createIndexTraceRef("generation", rawGeneration);

        expect(policyRef).toMatch(/^policy:[0-9a-f]{8}$/);
        expect(generationRef).toMatch(/^generation:[0-9a-f]{8}$/);
        expect(`${policyRef}${generationRef}`).not.toContain("private");
        expect(createIndexTraceRef("policy", rawPolicy)).toBe(policyRef);
    });

    it("settles a span at most once", () => {
        const trace = new IndexLifecycleTrace(10, createClock([1, 2, 3]));
        const span = trace.begin("graph-job.run");
        span.finish("cancelled", "aborted");
        span.finish("completed");
        span.checkpoint({ processed: 1 });

        expect(trace.getEvents()).toEqual([
            expect.objectContaining({ status: "started" }),
            expect.objectContaining({ status: "cancelled", errorCode: "aborted" }),
        ]);
    });
});

function createClock(values: number[]): () => number {
    let index = 0;
    return () => values[index++] ?? values.at(-1) ?? 0;
}
