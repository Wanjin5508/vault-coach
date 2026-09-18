import { describe, expect, it } from "vitest";
import { LiteEngineClient } from "../../../src/app/engine/lite-engine-client";

describe("LiteEngineClient", () => {
    it("is an available local fallback that has no endpoint, transfer, or network work", async () => {
        const client = new LiteEngineClient();

        expect(client.getAvailability()).toEqual({
            mode: "lite",
            status: "available",
            protocolVersion: 1,
            capabilities: [],
            reason: "lite-default",
            detail: "Vault Coach Lite is active; no Knowledge Engine service is configured.",
        });
        expect(client.getDiagnostics()).toEqual({
            endpoint: null,
            lastCheckedAt: null,
            lastError: null,
            networkRequestsMade: 0,
            dataTransfer: "none",
        });
        await expect(client.refresh()).resolves.toEqual(client.getAvailability());
    });

    it("honours cancellation without replacing Lite with a service dependency", async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(new LiteEngineClient().refresh(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    });
});
