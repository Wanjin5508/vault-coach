import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import {
    KnowledgeScopePickerModal,
    toKnowledgeScopeSelection,
} from "../../src/presentation/settings/knowledge-scope-picker-modal";
import type { KnowledgeScopeOption } from "../../src/app/knowledge/knowledge-scope-types";

const OPTIONS: KnowledgeScopeOption[] = [
    { id: "whole-vault", kind: "whole-vault", depth: 0, selected: true },
    { id: "folder:项目/AI", kind: "folder", path: "项目/AI", depth: 2, exists: true, selected: false },
];

describe("KnowledgeScopePickerModal", () => {
    it("maps root and folder options without exposing persistence fields", () => {
        expect(toKnowledgeScopeSelection(OPTIONS[0]!)).toEqual({ kind: "whole-vault" });
        expect(toKnowledgeScopeSelection(OPTIONS[1]!)).toEqual({ kind: "folder", path: "项目/AI" });
    });

    it("returns searchable labels and calls the injected selection callback once", async () => {
        const onChoose = vi.fn(async () => undefined);
        const onError = vi.fn();
        const modal = new KnowledgeScopePickerModal(new App(), OPTIONS, onChoose, onError, (key) => key);

        expect(modal.getItems()).not.toBe(OPTIONS);
        expect(modal.getItemText(OPTIONS[0]!)).toContain("settings.scope.wholeVault");
        expect(modal.getItemText(OPTIONS[1]!)).toBe("项目/AI");

        modal.onChooseItem(OPTIONS[1]!);
        await Promise.resolve();
        expect(onChoose).toHaveBeenCalledOnce();
        expect(onChoose).toHaveBeenCalledWith({ kind: "folder", path: "项目/AI" });
        expect(onError).not.toHaveBeenCalled();
    });

    it("routes an async selection failure to one error handler", async () => {
        const error = new Error("disk unavailable");
        const onError = vi.fn();
        const modal = new KnowledgeScopePickerModal(
            new App(),
            OPTIONS,
            vi.fn(async () => { throw error; }),
            onError,
            (key) => key,
        );

        modal.onChooseItem(OPTIONS[1]!);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(error);
    });
});
