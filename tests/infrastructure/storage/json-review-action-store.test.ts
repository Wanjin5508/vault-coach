import { describe, expect, it } from "vitest";
import { RECOMMENDATIONS_DIR_PATH, REVIEW_ACTIONS_PATH, VAULT_COACH_HIDDEN_DIR_PATH } from "../../../src/constants";
import { JsonReviewActionStore, type ReviewActionStorageAdapter } from "../../../src/infrastructure/storage/json-review-action-store";

describe("JsonReviewActionStore", () => {
    it("persists only append-only learner actions in its own local directory", async () => {
        const adapter = new InMemoryReviewActionAdapter();
        const store = new JsonReviewActionStore(adapter);
        const event = { id: "action-1", recommendationId: "recommendation:concept:rag", action: "deferred" as const, occurredAt: 100, deferUntil: 200 };

        await store.append(event);
        await store.append(event);

        expect(adapter.directories).toEqual(new Set([VAULT_COACH_HIDDEN_DIR_PATH, RECOMMENDATIONS_DIR_PATH]));
        expect(adapter.files.has(REVIEW_ACTIONS_PATH)).toBe(true);
        await expect(store.list()).resolves.toEqual([event]);
    });

    it("refuses an invalid persisted action document instead of replacing user action facts", async () => {
        const adapter = new InMemoryReviewActionAdapter();
        adapter.files.set(REVIEW_ACTIONS_PATH, JSON.stringify({ schemaVersion: 1, events: [{ id: "bad" }] }));

        await expect(new JsonReviewActionStore(adapter).list()).rejects.toThrow("事件格式无效");
    });
});

class InMemoryReviewActionAdapter implements ReviewActionStorageAdapter {
    readonly files = new Map<string, string>();
    readonly directories = new Set<string>();

    async exists(path: string): Promise<boolean> { return this.files.has(path) || this.directories.has(path); }
    async read(path: string): Promise<string> {
        const value = this.files.get(path);
        if (value === undefined) throw new Error(`Missing ${path}`);
        return value;
    }
    async write(path: string, data: string): Promise<void> { this.files.set(path, data); }
    async mkdir(path: string): Promise<void> { this.directories.add(path); }
}
