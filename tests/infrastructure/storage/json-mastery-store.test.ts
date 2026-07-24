import { describe, expect, it } from "vitest";
import { MASTERY_SNAPSHOT_PATH } from "../../../src/constants";
import { JsonMasteryStore, type MasteryStorageAdapter } from "../../../src/infrastructure/storage/json-mastery-store";
import type { MasterySnapshotV1 } from "../../../src/domain/mastery/mastery-types";

describe("JsonMasteryStore", () => {
    it("persists a rebuildable snapshot outside Assessment facts and clears only its own cache", async () => {
        const adapter = new InMemoryMasteryAdapter();
        const store = new JsonMasteryStore(adapter);
        const snapshot = masterySnapshot();

        await store.save(snapshot);

        expect(adapter.files.has(MASTERY_SNAPSHOT_PATH)).toBe(true);
        expect(adapter.files.has(".vault-coach/assessments/sessions/session-1.json")).toBe(false);
        await expect(store.load()).resolves.toEqual(snapshot);

        await store.clear();
        await expect(store.load()).resolves.toBeNull();
    });

    it("recovers a validated temporary snapshot when the final write was interrupted", async () => {
        const adapter = new InMemoryMasteryAdapter();
        adapter.files.set(`${MASTERY_SNAPSHOT_PATH}.tmp`, JSON.stringify(masterySnapshot()));
        const store = new JsonMasteryStore(adapter);

        await expect(store.load()).resolves.toEqual(masterySnapshot());
        expect(adapter.files.has(MASTERY_SNAPSHOT_PATH)).toBe(true);
        expect(adapter.files.has(`${MASTERY_SNAPSHOT_PATH}.tmp`)).toBe(false);
    });

    it("rejects an invalid cached payload so the application can mark it dirty and rebuild", async () => {
        const adapter = new InMemoryMasteryAdapter();
        adapter.files.set(MASTERY_SNAPSHOT_PATH, "{not JSON");
        const store = new JsonMasteryStore(adapter);

        await expect(store.load()).rejects.toThrow("无法解析");
    });
});

function masterySnapshot(): MasterySnapshotV1 {
    return {
        schemaVersion: 1,
        algorithmVersion: "mastery/v1",
        calculatedAt: 1,
        sourceEventCount: 1,
        unboundIssues: [],
        states: [{
            conceptId: "concept:alpha",
            masteryScore: 0.8,
            confidence: 0.6,
            level: "proficient",
            assessmentCount: 1,
            effectiveEvidenceCount: 1,
            lastAssessedAt: 1,
            lastReviewedAt: null,
            nextReviewAt: 2,
            commonErrorCodes: [],
            trend: "unknown",
            evidence: [{
                eventId: "event-1",
                sessionId: "session-1",
                questionId: "question-1",
                bindingKind: "direct-concept-id",
                normalizedScore: 0.8,
                weight: 1,
                occurredAt: 1,
                difficulty: "intermediate",
                errorCodes: [],
            }],
            calculatedAt: 1,
            algorithmVersion: "mastery/v1",
        }],
    };
}

class InMemoryMasteryAdapter implements MasteryStorageAdapter {
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
    async rename(oldPath: string, newPath: string): Promise<void> {
        if (this.files.has(newPath)) throw new Error("Destination file already exists!");
        this.files.set(newPath, await this.read(oldPath));
        this.files.delete(oldPath);
    }
    async remove(path: string): Promise<void> { this.files.delete(path); this.directories.delete(path); }
}
