import { describe, expect, it } from "vitest";
import { buildKnowledgeScopeOptions } from "../../../src/app/knowledge/knowledge-scope-catalog";
import type { VaultFolderSnapshot } from "../../../src/app/knowledge/knowledge-scope-types";

describe("knowledge scope catalog", () => {
    it("keeps the root first, limits new choices to two levels, and keeps parent groups together", () => {
        const folders: VaultFolderSnapshot[] = [
            { path: "/", isRoot: true },
            { path: "学习/机器学习/论文", isRoot: false },
            { path: "项目/Vault Coach", isRoot: false },
            { path: "学习", isRoot: false },
            { path: "项目", isRoot: false },
            { path: "学习/机器学习", isRoot: false },
        ];

        const result = buildKnowledgeScopeOptions({
            folders,
            current: { kind: "whole-vault" },
            maxSelectableDepth: 2,
        });

        expect(result.map((option) => option.kind === "whole-vault" ? option.id : option.path)).toEqual([
            "whole-vault",
            "学习",
            "学习/机器学习",
            "项目",
            "项目/Vault Coach",
        ]);
        expect(folders[0]).toEqual({ path: "/", isRoot: true });
    });

    it("normalizes, deduplicates, and excludes the Vault Coach internal directory", () => {
        const result = buildKnowledgeScopeOptions({
            folders: [
                { path: "项目\\AI\\", isRoot: false },
                { path: "/项目//AI/", isRoot: false },
                { path: ".vault-coach", isRoot: false },
                { path: ".vault-coach/graph", isRoot: false },
            ],
            current: { kind: "folder", path: "项目/AI" },
            maxSelectableDepth: 2,
        });

        expect(result).toEqual([
            expect.objectContaining({ id: "whole-vault", selected: false }),
            expect.objectContaining({ id: "folder:项目/AI", path: "项目/AI", selected: true, exists: true }),
        ]);
    });

    it("preserves an existing deep legacy folder as the selected status item", () => {
        const result = buildKnowledgeScopeOptions({
            folders: [
                { path: "研究", isRoot: false },
                { path: "研究/课程", isRoot: false },
                { path: "研究/课程/2025", isRoot: false },
            ],
            current: { kind: "folder", path: "研究/课程/2025" },
            maxSelectableDepth: 2,
        });

        expect(result[1]).toEqual(expect.objectContaining({
            kind: "legacy-folder",
            path: "研究/课程/2025",
            depth: 3,
            exists: true,
            selected: true,
        }));
    });

    it("preserves a missing configured folder without silently selecting the whole Vault", () => {
        const result = buildKnowledgeScopeOptions({
            folders: [],
            current: { kind: "folder", path: "Archive/Old" },
            maxSelectableDepth: 2,
        });

        expect(result).toEqual([
            expect.objectContaining({ kind: "whole-vault", selected: false }),
            expect.objectContaining({ kind: "legacy-folder", path: "Archive/Old", exists: false, selected: true }),
        ]);
    });

    it("returns only the whole Vault option for an empty new installation", () => {
        expect(buildKnowledgeScopeOptions({
            folders: [],
            current: { kind: "whole-vault" },
            maxSelectableDepth: 2,
        })).toEqual([{ id: "whole-vault", kind: "whole-vault", depth: 0, selected: true }]);
    });
});
