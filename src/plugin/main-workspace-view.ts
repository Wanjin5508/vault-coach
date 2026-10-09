import type { Workspace } from "obsidian";

/**
 * 在普通 Obsidian 工作区叶片中打开可复用 View Type。
 *
 * 本函数不选择侧边栏叶片；Progress、Learning Map 和 Concept review 必须保持为
 * 可关闭、可拆分的工作区标签页。
 */
export async function activateMainWorkspaceView(workspace: Workspace, viewType: string): Promise<void> {
    let leaf = workspace.getLeavesOfType(viewType)[0] ?? null;
    if (!leaf) {
        leaf = workspace.getLeaf(true);
        await leaf.setViewState({ type: viewType, active: true });
    }
    workspace.setActiveLeaf(leaf, { focus: true });
}
