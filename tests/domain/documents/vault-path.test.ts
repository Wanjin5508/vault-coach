import { describe, expect, it } from "vitest";
import {
    getParentFolderPaths,
    getVaultFolderDepth,
    isFileInFolder,
    isVaultCoachHiddenPath,
    normalizeVaultPath,
} from "../../../src/domain/documents/vault-path";

describe("Vault path rules", () => {
    it("normalizes Vault relative paths without platform path APIs", () => {
        expect(normalizeVaultPath(" /项目\\AI///论文/ ")).toBe("项目/AI/论文");
        expect(getVaultFolderDepth("项目/AI/论文")).toBe(3);
        expect(getVaultFolderDepth("/")).toBe(0);
    });

    it("shares hidden-directory and recursive folder semantics", () => {
        expect(isVaultCoachHiddenPath(".vault-coach/graph/data.json")).toBe(true);
        expect(isVaultCoachHiddenPath("notes/.vault-coach-overview.md")).toBe(false);
        expect(isFileInFolder("项目/AI/论文/note.md", "项目/AI")).toBe(true);
        expect(getParentFolderPaths("项目/AI/论文/note.md")).toEqual(["项目", "项目/AI", "项目/AI/论文"]);
    });
});
