import { describe, expect, it } from "vitest";
import {
    LOCAL_AI_WORKER_PROTOCOL_VERSION,
    parseLocalAiWorkerMessage,
    parseLocalAiWorkerRequest,
} from "../../../src/infrastructure/local-ai/local-ai-worker-protocol";

describe("local AI worker protocol", () => {
    it("accepts a complete versioned request envelope", () => {
        expect(parseLocalAiWorkerRequest({
            v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
            requestId: "request-1",
            jobId: "job-1",
            workerEpoch: 2,
            role: "embedding",
            policyId: "policy-1",
            operation: "embed",
            payload: { texts: ["hello"] },
        })).toMatchObject({ requestId: "request-1", workerEpoch: 2, operation: "embed" });
    });

    it("rejects unknown versions and malformed error envelopes", () => {
        expect(() => parseLocalAiWorkerRequest({ v: 99 })).toThrow("Invalid local AI worker request envelope");
        expect(parseLocalAiWorkerMessage({
            v: LOCAL_AI_WORKER_PROTOCOL_VERSION,
            type: "response",
            requestId: "request-1",
            jobId: "job-1",
            workerEpoch: 1,
            role: "embedding",
            policyId: "policy-1",
            ok: false,
            error: { message: "unsafe" },
        })).toBeNull();
    });
});
