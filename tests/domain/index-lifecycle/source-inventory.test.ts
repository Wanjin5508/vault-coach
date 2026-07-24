import { describe, expect, it } from "vitest";
import {
    compareSourceInventories,
    createSourceInventory,
    getSourceInventoryStatus,
} from "../../../src/domain/index-lifecycle/source-inventory";

describe("SourceInventory", () => {
    it("is deterministic regardless of source file order", () => {
        const first = createSourceInventory("scope", [
            { path: "notes/b.md", size: 20, modifiedAt: 2 },
            { path: "notes/a.md", size: 10, modifiedAt: 1 },
        ], 10);
        const second = createSourceInventory("scope", [
            { path: "notes/a.md", size: 10, modifiedAt: 1 },
            { path: "notes/b.md", size: 20, modifiedAt: 2 },
        ], 99);

        expect(first.fingerprint).toBe(second.fingerprint);
        expect(first.files.map((file) => file.path)).toEqual(["notes/a.md", "notes/b.md"]);
    });

    it("classifies a complete unrelated replacement as a possible domain switch", () => {
        const previous = createSourceInventory("scope", [
            { path: "frontend/a.md", size: 1, modifiedAt: 1 },
            { path: "frontend/b.md", size: 1, modifiedAt: 1 },
        ]);
        const current = createSourceInventory("scope", [
            { path: "database/a.md", size: 1, modifiedAt: 1 },
            { path: "database/b.md", size: 1, modifiedAt: 1 },
        ]);

        const diff = compareSourceInventories(previous, current);
        expect(diff).toMatchObject({
            addedPaths: ["database/a.md", "database/b.md"],
            removedPaths: ["frontend/a.md", "frontend/b.md"],
            unchangedCount: 0,
            isPossibleDomainSwitch: true,
        });
        expect(getSourceInventoryStatus(previous, current).status).toBe("possible-domain-switch");
    });

    it("requires synchronization for a bounded offline edit without calling it a domain switch", () => {
        const previous = createSourceInventory("scope", [
            { path: "notes/a.md", size: 10, modifiedAt: 1 },
            { path: "notes/b.md", size: 20, modifiedAt: 1 },
            { path: "notes/c.md", size: 30, modifiedAt: 1 },
            { path: "notes/d.md", size: 40, modifiedAt: 1 },
        ]);
        const current = createSourceInventory("scope", [
            { path: "notes/a.md", size: 11, modifiedAt: 2 },
            { path: "notes/b.md", size: 20, modifiedAt: 1 },
            { path: "notes/c.md", size: 30, modifiedAt: 1 },
            { path: "notes/d.md", size: 40, modifiedAt: 1 },
        ]);

        expect(getSourceInventoryStatus(previous, current)).toMatchObject({
            status: "source-sync-required",
            diff: { modifiedPaths: ["notes/a.md"], isPossibleDomainSwitch: false },
        });
    });

    it("requires synchronization when the configured knowledge scope changes", () => {
        const files = [{ path: "notes/a.md", size: 10, modifiedAt: 1 }];
        const previous = createSourceInventory("whole-vault", files);
        const current = createSourceInventory("folder:notes", files);

        expect(getSourceInventoryStatus(previous, current)).toMatchObject({
            status: "source-sync-required",
            diff: { changedRatio: 0, isPossibleDomainSwitch: false },
        });
    });
});
