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

    it("round-trips bounded filters and focus history as leaf-local explorer state", () => {
        const api = {
            getProjection: async () => { throw new Error("not used by this state test"); },
            getConceptCatalog: async () => { throw new Error("not used by this state test"); },
        };
        const controller = new LearningMapController(api);
        controller.setSearch("docker");
        controller.setStructuralContext(true);
        controller.setAutomaticRelationsVisible(false);
        controller.setRelationTypes(["used_for", "prerequisite_of"]);
        controller.setFullGraph(false);
        controller.setFocus("concept:docker");

        const restored = new LearningMapController(api);
        restored.restoreViewState(controller.getViewState());

        expect(restored.getFocus()).toBe("concept:docker");
        expect(restored.getRelationTypes()).toEqual(["used_for", "prerequisite_of"]);
        expect(restored.hasStructuralContext()).toBe(true);
        expect(restored.hasAutomaticRelationsVisible()).toBe(false);
        expect(restored.isFullGraph()).toBe(false);
        expect(restored.canGoBack()).toBe(true);
        expect(restored.goBack()).toBe(true);
        expect(restored.getSearch()).toBe("docker");
    });

    it("ignores malformed persisted state and retains a safe default", () => {
        const controller = new LearningMapController({
            getProjection: async () => { throw new Error("not used by this state test"); },
            getConceptCatalog: async () => { throw new Error("not used by this state test"); },
        });

        controller.restoreViewState({ version: 1, query: { maxNodes: "all" }, focusHistory: "not-an-array" });

        expect(controller.isFullGraph()).toBe(true);
        expect(controller.getSearch()).toBe("");
        expect(controller.canGoBack()).toBe(false);
    });
});
