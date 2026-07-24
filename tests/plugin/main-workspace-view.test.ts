import type { Workspace } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { activateMainWorkspaceView } from "../../src/plugin/main-workspace-view";

describe("activateMainWorkspaceView", () => {
    it("reuses and focuses an existing workspace leaf", async () => {
        const setViewState = vi.fn();
        const getLeavesOfType = vi.fn(() => [{ setViewState }]);
        const getLeaf = vi.fn();
        const setActiveLeaf = vi.fn();
        const leaf = { setViewState };
        const workspace = {
            getLeavesOfType,
            getLeaf,
            setActiveLeaf,
        } as unknown as Workspace;

        await activateMainWorkspaceView(workspace, "vault-coach-progress");

        expect(getLeavesOfType).toHaveBeenCalledWith("vault-coach-progress");
        expect(getLeaf).not.toHaveBeenCalled();
        expect(setViewState).not.toHaveBeenCalled();
        expect(setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    });

    it("creates, initializes, and focuses a normal workspace leaf when needed", async () => {
        const setViewState = vi.fn(async () => undefined);
        const leaf = { setViewState };
        const getLeavesOfType = vi.fn(() => []);
        const getLeaf = vi.fn(() => leaf);
        const setActiveLeaf = vi.fn();
        const workspace = {
            getLeavesOfType,
            getLeaf,
            setActiveLeaf,
        } as unknown as Workspace;

        await activateMainWorkspaceView(workspace, "vault-coach-progress");

        expect(getLeaf).toHaveBeenCalledWith(true);
        expect(setViewState).toHaveBeenCalledWith({ type: "vault-coach-progress", active: true });
        expect(setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    });
});
