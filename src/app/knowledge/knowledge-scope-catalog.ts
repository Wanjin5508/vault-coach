import {
    getVaultFolderDepth,
    isVaultCoachHiddenPath,
    normalizeVaultPath,
} from "../../domain/documents/vault-path";
import type {
    KnowledgeScopeOption,
    KnowledgeScopeSelection,
    VaultFolderSnapshot,
} from "./knowledge-scope-types";

export interface BuildKnowledgeScopeOptionsInput {
    folders: readonly VaultFolderSnapshot[];
    current: KnowledgeScopeSelection;
    maxSelectableDepth: number;
}

/**
 * 构建设置页目录选项。
 *
 * 新选择只展示限定深度内的目录；当前旧配置即使更深或已不存在，也会作为状态项保留。
 */
export function buildKnowledgeScopeOptions(input: BuildKnowledgeScopeOptionsInput): KnowledgeScopeOption[] {
    const normalizedPaths = new Set<string>();
    for (const folder of input.folders) {
        const path = normalizeVaultPath(folder.path);
        if (folder.isRoot || path.length === 0 || isVaultCoachHiddenPath(path)) continue;
        normalizedPaths.add(path);
    }

    const existingPaths = new Set(normalizedPaths);
    const selectablePaths = Array.from(normalizedPaths)
        .filter((path) => getVaultFolderDepth(path) <= input.maxSelectableDepth)
        .sort(compareFolderPaths);
    const currentPath = input.current.kind === "folder"
        ? normalizeVaultPath(input.current.path)
        : null;

    const options: KnowledgeScopeOption[] = [{
        id: "whole-vault",
        kind: "whole-vault",
        depth: 0,
        selected: input.current.kind === "whole-vault",
    }];

    if (currentPath !== null && !selectablePaths.includes(currentPath)) {
        options.push(createFolderOption(currentPath, "legacy-folder", existingPaths.has(currentPath), true));
    }

    for (const path of selectablePaths) {
        options.push(createFolderOption(path, "folder", true, currentPath === path));
    }
    return options;
}

function createFolderOption(
    path: string,
    kind: "folder" | "legacy-folder",
    exists: boolean,
    selected: boolean,
): KnowledgeScopeOption {
    return {
        id: `folder:${path}`,
        kind,
        path,
        depth: getVaultFolderDepth(path),
        exists,
        selected,
    };
}

/** 先比较共同父路径，保证父目录紧邻并排在自己的后代之前。 */
function compareFolderPaths(left: string, right: string): number {
    const leftParts = left.split("/");
    const rightParts = right.split("/");
    const commonLength = Math.min(leftParts.length, rightParts.length);
    for (let index = 0; index < commonLength; index += 1) {
        const leftPart = leftParts[index] ?? "";
        const rightPart = rightParts[index] ?? "";
        const order = leftPart.localeCompare(rightPart);
        if (order !== 0) return order;
    }
    return leftParts.length - rightParts.length;
}
