import type { Workspace } from "obsidian";

/**
 * Opens a reusable View Type in a normal Obsidian workspace leaf.
 *
 * The helper intentionally does not choose a sidebar leaf: Progress, Learning
 * Map, and Concept review must remain closable and splittable workspace tabs.
 */
export async function activateMainWorkspaceView(workspace: Workspace, viewType: string): Promise<void> {
    let leaf = workspace.getLeavesOfType(viewType)[0] ?? null;
    if (!leaf) {
        leaf = workspace.getLeaf(true);
        await leaf.setViewState({ type: viewType, active: true });
    }
    workspace.setActiveLeaf(leaf, { focus: true });
}
