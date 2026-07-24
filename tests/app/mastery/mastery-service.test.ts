import { describe, expect, it, vi } from "vitest";
import { MasteryService } from "../../../src/app/mastery/mastery-service";
import type { AssessmentSessionDocumentV1 } from "../../../src/domain/assessment/assessment-types";
import type { AssessmentSessionStore } from "../../../src/domain/assessment/assessment-types";
import type { LearningGraphConceptCatalog } from "../../../src/domain/learning-graph/learning-graph-types";
import type { MasterySnapshotV1, MasteryStore } from "../../../src/domain/mastery/mastery-types";

describe("MasteryService", () => {
    it("rebuilds all concepts once, then recalculates only concepts affected by a newly saved session", async () => {
        let now = 100;
        const documents = [document("session-alpha", "event-alpha", "concept:alpha", 0.4)];
        const store = new MemoryMasteryStore();
        const service = new MasteryService({
            assessmentSessionStore: assessmentStore(documents),
            catalogReader: { getConceptCatalog: () => catalog() },
            store,
            getCapacityAssessment: () => capacity("local"),
            getNow: () => now,
        });

        const initial = await service.rebuildAll();
        expect(initial.states.map((state) => [state.conceptId, state.calculatedAt])).toEqual([
            ["concept:alpha", 100],
            ["concept:beta", 100],
        ]);

        now = 200;
        const added = document("session-alpha-2", "event-alpha-2", "concept:alpha", 1);
        documents.push(added);
        const sync = await service.syncForSession(added);
        const snapshot = service.getSnapshot();

        expect(sync).toEqual({ updated: true, recalculatedConceptIds: ["concept:alpha"] });
        expect(snapshot?.states.find((state) => state.conceptId === "concept:alpha")?.calculatedAt).toBe(200);
        expect(snapshot?.states.find((state) => state.conceptId === "concept:beta")?.calculatedAt).toBe(100);
        expect(snapshot?.states.find((state) => state.conceptId === "concept:alpha")?.masteryScore).toBeGreaterThan(0.4);
        expect(store.save).toHaveBeenCalledTimes(2);
    });

    it("preserves a readable snapshot and makes no new local computation above the capacity budget", async () => {
        const documents = [document("session-alpha", "event-alpha", "concept:alpha", 0.8)];
        const store = new MemoryMasteryStore();
        let level = "local";
        const service = new MasteryService({
            assessmentSessionStore: assessmentStore(documents),
            catalogReader: { getConceptCatalog: () => catalog() },
            store,
            getCapacityAssessment: () => capacity(level),
            getNow: () => 100,
        });
        await service.rebuildAll();
        const before = service.getSnapshot();

        level = "service-preferred";
        const result = await service.syncForSession(documents[0]!);

        expect(result).toEqual({ updated: false, recalculatedConceptIds: [], reason: "capacity" });
        expect(service.getSnapshot()).toEqual(before);
        expect(service.getState()).toMatchObject({ dirty: true, hasSnapshot: true });
        await expect(service.rebuildAll()).rejects.toThrow("独立服务");
    });

    it("loads a v1 snapshot as dirty instead of treating pre-source-chunk evidence as current", async () => {
        const store = new MemoryMasteryStore({
            schemaVersion: 1,
            algorithmVersion: "mastery/v1",
            calculatedAt: 1,
            states: [],
            sourceEventCount: 0,
            unboundIssues: [],
        });
        const service = new MasteryService({
            assessmentSessionStore: assessmentStore([]),
            catalogReader: { getConceptCatalog: () => catalog() },
            store,
            getCapacityAssessment: () => capacity("local"),
        });

        await service.load();

        expect(service.getState()).toMatchObject({ hasSnapshot: true, dirty: true, algorithmVersion: "mastery/v1" });
    });
});

function document(sessionId: string, eventId: string, conceptId: string, score: number): AssessmentSessionDocumentV1 {
    return {
        schemaVersion: 1,
        sessionId,
        savedAt: 1,
        examSession: { id: sessionId } as AssessmentSessionDocumentV1["examSession"],
        conceptBindings: [],
        assessmentEvents: [{
            id: eventId,
            eventType: "exam-answer",
            sessionId,
            questionId: `question-${eventId}`,
            conceptIds: [conceptId],
            sourceChunkIds: ["chunk-1"],
            rawScore: Math.round(score * 100),
            normalizedScore: score,
            difficulty: "intermediate",
            questionType: "explanation",
            errorCodes: [],
            evidenceConfidence: 1,
            evaluationConfidence: 1,
            occurredAt: 1,
            evaluator: { provider: "test", model: "test", promptVersion: "test/v1" },
        }],
    };
}

function assessmentStore(documents: AssessmentSessionDocumentV1[]): AssessmentSessionStore {
    return {
        list: async () => documents,
        save: async () => undefined,
        read: async () => null,
        listHistory: async () => [],
        rebuildIndex: async () => ({ schemaVersion: 1 as const, entries: [] }),
    };
}

function catalog(): LearningGraphConceptCatalog {
    return {
        sourceReady: true,
        message: null,
        concepts: [
            { id: "concept:alpha", label: "Alpha", aliases: [], sourcePaths: [], sourceChunkIds: [] },
            { id: "concept:beta", label: "Beta", aliases: [], sourcePaths: [], sourceChunkIds: [] },
        ],
    };
}

function capacity(level: string) {
    return {
        level,
        reasons: [],
        rawVectorBytes: null,
        hasUnknownMetrics: false,
        allowManualSemanticBuild: true,
        allowAutomaticSemanticSync: true,
    } as ReturnType<typeof import("../../../src/domain/graph-capacity/graph-capacity-assessment")["assessGraphCapacity"]>;
}

class MemoryMasteryStore implements MasteryStore {
    snapshot: MasterySnapshotV1 | null;
    readonly save = vi.fn(async (snapshot: MasterySnapshotV1) => { this.snapshot = structuredClone(snapshot); });

    constructor(snapshot: MasterySnapshotV1 | null = null) { this.snapshot = snapshot; }

    async load(): Promise<MasterySnapshotV1 | null> { return this.snapshot ? structuredClone(this.snapshot) : null; }
    async clear(): Promise<void> { this.snapshot = null; }
}
