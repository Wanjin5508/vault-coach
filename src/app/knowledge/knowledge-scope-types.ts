/** 设置页中的单一知识库范围选择。 */
export type KnowledgeScopeSelection =
    | { kind: "whole-vault" }
    | { kind: "folder"; path: string };

/** 从 Obsidian Vault 边界读取后交给纯目录表函数的数据。 */
export interface VaultFolderSnapshot {
    path: string;
    isRoot: boolean;
}

/** 设置页可展示的知识库范围选项，不包含 DOM 或本地化文案。 */
export type KnowledgeScopeOption =
    | {
        id: "whole-vault";
        kind: "whole-vault";
        depth: 0;
        selected: boolean;
    }
    | {
        id: `folder:${string}`;
        kind: "folder" | "legacy-folder";
        path: string;
        depth: number;
        exists: boolean;
        selected: boolean;
    };
