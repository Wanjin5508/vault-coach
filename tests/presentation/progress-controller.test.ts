import { describe, expect, it } from "vitest";
import { ProgressController } from "../../src/presentation/controllers/progress-controller";

describe("ProgressController", () => {
    it("keeps Progress unavailable without fabricating a dashboard state", () => {
        const controller = new ProgressController({
            isAvailable: () => false,
            getSnapshot: async () => {
                throw new Error("Progress service is unavailable.");
            },
        });

        expect(controller.isAvailable()).toBe(false);
        expect(controller.getState()).toEqual({ available: false });

        controller.dispose();
        expect(controller.getState()).toEqual({ available: false });
    });
});
