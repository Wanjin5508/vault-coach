import { describe, expect, it } from "vitest";
import { ProgressController } from "../../src/presentation/controllers/progress-controller";

describe("ProgressController", () => {
    it("keeps Progress unavailable without fabricating a dashboard state", () => {
        const controller = new ProgressController({
            isAvailable: () => false,
            getState: () => ({
                hasSnapshot: false,
                dirty: true,
                busy: false,
                lastError: "Progress service is unavailable.",
                generatedAt: null,
            }),
            getSnapshot: async () => {
                throw new Error("Progress service is unavailable.");
            },
        });

        expect(controller.isAvailable()).toBe(false);
        expect(controller.getState()).toEqual({
            available: false,
            hasSnapshot: false,
            dirty: true,
            busy: false,
            lastError: "Progress service is unavailable.",
            generatedAt: null,
        });

        controller.dispose();
        expect(controller.getState()).toMatchObject({ available: false, dirty: true });
    });
});
