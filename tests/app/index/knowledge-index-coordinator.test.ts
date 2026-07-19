import { describe, expect, it } from "vitest";
import { KnowledgeIndexCoordinator } from "../../../src/app/index/knowledge-index-coordinator";

describe("KnowledgeIndexCoordinator", () => {
    it("owns dirty, busy, and cancellation state", () => {
        let stateChanges = 0;
        const coordinator = new KnowledgeIndexCoordinator(() => {
            stateChanges += 1;
        });
        const controller = new AbortController();

        coordinator.setTextDirty(false);
        coordinator.setVectorDirty(false);
        coordinator.setBusy("rebuilding");
        coordinator.setActiveAbortController(controller);
        coordinator.dispose();

        expect(coordinator.getTextDirty()).toBe(false);
        expect(coordinator.getVectorDirty()).toBe(false);
        expect(coordinator.getBusyState()).toEqual({ busy: false, phase: null, startedAt: null });
        expect(controller.signal.aborted).toBe(true);
        expect(stateChanges).toBeGreaterThan(2);
    });
});
