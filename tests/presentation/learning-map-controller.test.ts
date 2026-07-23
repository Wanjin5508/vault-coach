import { describe, expect, it } from "vitest";
import { LearningMapController } from "../../src/presentation/controllers/learning-map-controller";

describe("LearningMapController", () => {
    it("returns through bounded focus history without losing the prior search", () => {
        const controller = new LearningMapController({
            getProjection: async () => { throw new Error("not used by this state test"); },
            getConceptCatalog: async () => { throw new Error("not used by this state test"); },
        });

        expect(controller.isFullGraph()).toBe(true);

        controller.setSearch("database");
        controller.setFocus("concept:sql");
        controller.setFocus("concept:index");

        expect(controller.canGoBack()).toBe(true);
        expect(controller.getFocus()).toBe("concept:index");
        expect(controller.getSearch()).toBe("");

        expect(controller.goBack()).toBe(true);
        expect(controller.getFocus()).toBe("concept:sql");
        expect(controller.getSearch()).toBe("");

        expect(controller.goBack()).toBe(true);
        expect(controller.getFocus()).toBeUndefined();
        expect(controller.getSearch()).toBe("database");
        expect(controller.canGoBack()).toBe(false);
        expect(controller.goBack()).toBe(false);
    });

    it("clears stale focus history when a new global search starts", () => {
        const controller = new LearningMapController({
            getProjection: async () => { throw new Error("not used by this state test"); },
            getConceptCatalog: async () => { throw new Error("not used by this state test"); },
        });

        controller.setFocus("concept:sql");
        expect(controller.canGoBack()).toBe(true);

        controller.setSearch("docker");
        expect(controller.canGoBack()).toBe(false);
        expect(controller.getFocus()).toBeUndefined();
        expect(controller.getSearch()).toBe("docker");
    });
});
