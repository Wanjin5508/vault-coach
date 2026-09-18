import { describe, expect, it, vi } from "vitest";
import { ProgressService } from "../../../src/app/progress/progress-service";
import type { AssessmentExamHistoryItem } from "../../../src/domain/assessment/assessment-types";
import type { LearningGraphConceptCatalog } from "../../../src/domain/learning-graph/learning-graph-types";
import type { ConceptMasteryState, MasterySnapshotV1, MasteryStateView } from "../../../src/domain/mastery/mastery-types";

describe("ProgressService", () => {
    it("aggregates the effective catalog, current Mastery snapshot, and structured Assessment history", async () => {
        const service = new ProgressService({
            catalogReader: {
                getConceptCatalog: () => createCatalog(["concept:rag", "concept:vector", "concept:prompt"]),
            },
            masteryReader: {
                getState: () => createMasteryState(),
                getSnapshot: () => createSnapshot([
                    createConceptState("concept:rag", "weak", 1),
                    createConceptState("concept:vector", "mastered", 2),
                    createConceptState("concept:prompt", "unknown", 0),
                    createConceptState("concept:removed", "proficient", 3),
                ]),
            },
            assessmentSessionStore: {
                listHistory: async () => createHistory(),
            },
            getNow: () => 1234,
        });

        const snapshot = await service.getSnapshot();

        expect(snapshot).toEqual({
            schemaVersion: 1,
            generatedAt: 1234,
            graph: {
                status: "ready",
                conceptCount: 3,
                message: null,
            },
            mastery: {
                status: "current",
                message: null,
                conceptCount: 3,
                assessedConceptCount: 2,
                coverageRatio: 2 / 3,
                levelCounts: {
                    unknown: 1,
                    weak: 1,
                    developing: 0,
                    proficient: 0,
                    mastered: 1,
                },
                snapshotCalculatedAt: 999,
                algorithmVersion: "mastery/v1",
                sourceEventCount: 6,
                unboundIssueCount: 1,
            },
            assessments: {
                status: "ready",
                message: null,
                sessionCount: 2,
                scoredSessionCount: 1,
                latestSessionAt: 30,
            },
            recommendations: [],
        });
    });

    it("returns explicit partial-data states instead of fabricating zero coverage when sources are unavailable", async () => {
        const service = new ProgressService({
            catalogReader: {
                getConceptCatalog: () => ({
                    concepts: [],
                    sourceReady: false,
                    message: "Rebuild the graph first.",
                }),
            },
            masteryReader: {
                getState: () => createMasteryState({ hasSnapshot: false, dirty: true, lastError: "No snapshot yet." }),
                getSnapshot: () => null,
            },
            assessmentSessionStore: {
                listHistory: async () => {
                    throw new Error("Assessment history unavailable.");
                },
            },
            getNow: () => 5678,
        });

        const snapshot = await service.getSnapshot();

        expect(snapshot.graph).toEqual({
            status: "unavailable",
            conceptCount: 0,
            message: "Rebuild the graph first.",
        });
        expect(snapshot.mastery).toMatchObject({
            status: "missing",
            message: "No snapshot yet.",
            conceptCount: 0,
            assessedConceptCount: 0,
            coverageRatio: null,
        });
        expect(snapshot.assessments).toEqual({
            status: "unavailable",
            message: "Assessment history unavailable.",
            sessionCount: 0,
            scoredSessionCount: 0,
            latestSessionAt: null,
        });
        expect(snapshot.recommendations).toEqual([]);
    });

    it("projects only the bounded open recommendation list without coupling Progress to action storage", async () => {
        const service = new ProgressService({
            catalogReader: { getConceptCatalog: () => createCatalog(["concept:rag"]) },
            masteryReader: {
                getState: () => createMasteryState({ stateCount: 1 }),
                getSnapshot: () => createSnapshot([createConceptState("concept:rag", "weak", 1)]),
            },
            assessmentSessionStore: { listHistory: async () => [] },
            recommendationReader: {
                getSnapshot: async () => ({
                    algorithmVersion: "recommendation/v1",
                    generatedAt: 100,
                    primary: [{
                        id: "recommendation:concept:rag", kind: "review-concept", label: "RAG", targetConceptIds: ["concept:rag"],
                        sourceChunkIds: ["rag#1"], priority: 500, reasonCodes: ["weak-mastery"], masteryScore: 0.2,
                        confidence: 0.8, lastAssessedAt: 1, nextReviewAt: null, suggestedAction: "practice-exam",
                        suggestedExamMode: "simple", actionState: "open",
                    }],
                    queue: [],
                }),
            },
            getNow: () => 100,
        });

        const snapshot = await service.getSnapshot();

        expect(snapshot.recommendations).toEqual([expect.objectContaining({
            id: "recommendation:concept:rag",
            reasonCodes: ["weak-mastery"],
            suggestedExamMode: "simple",
        })]);
    });

    it("caches completed reads, protects the cache from caller mutation, and rebuilds lazily after invalidation", async () => {
        let historyReadCount = 0;
        const listHistory = vi.fn(async () => {
            historyReadCount += 1;
            return createHistory();
        });
        const service = new ProgressService({
            catalogReader: {
                getConceptCatalog: () => createCatalog(["concept:rag"]),
            },
            masteryReader: {
                getState: () => createMasteryState({ stateCount: 1 }),
                getSnapshot: () => createSnapshot([createConceptState("concept:rag", "weak", 1)]),
            },
            assessmentSessionStore: { listHistory },
            getNow: () => 1000 + historyReadCount,
        });

        const first = await service.getSnapshot();
        (first.mastery.levelCounts as Record<string, number>).weak = 999;
        const cached = await service.getSnapshot();

        expect(listHistory).toHaveBeenCalledOnce();
        expect(cached.generatedAt).toBe(1001);
        expect(cached.mastery.levelCounts.weak).toBe(1);
        expect(service.getState()).toEqual({
            hasSnapshot: true,
            dirty: false,
            busy: false,
            lastError: null,
            generatedAt: 1001,
        });

        service.invalidate();
        expect(service.getState()).toMatchObject({ hasSnapshot: true, dirty: true, busy: false });

        const refreshed = await service.getSnapshot();
        expect(listHistory).toHaveBeenCalledTimes(2);
        expect(refreshed.generatedAt).toBe(1002);
        expect(service.getState()).toMatchObject({ dirty: false, generatedAt: 1002 });
    });

    it("coalesces concurrent reads so one view refresh does not duplicate Assessment history work", async () => {
        const deferredHistory = createDeferred<AssessmentExamHistoryItem[]>();
        const listHistory = vi.fn(() => deferredHistory.promise);
        const service = new ProgressService({
            catalogReader: {
                getConceptCatalog: () => createCatalog(["concept:rag"]),
            },
            masteryReader: {
                getState: () => createMasteryState({ stateCount: 1 }),
                getSnapshot: () => createSnapshot([createConceptState("concept:rag", "weak", 1)]),
            },
            assessmentSessionStore: { listHistory },
            getNow: () => 1000,
        });

        const first = service.getSnapshot();
        const second = service.getSnapshot();
        expect(service.getState()).toMatchObject({ busy: true, dirty: true });
        expect(listHistory).toHaveBeenCalledOnce();

        deferredHistory.resolve(createHistory());
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);

        expect(listHistory).toHaveBeenCalledOnce();
        expect(service.getState()).toMatchObject({ busy: false, dirty: false, hasSnapshot: true });
    });

    it("rebuilds before resolving when a source event invalidates an in-flight read", async () => {
        const firstHistory = createDeferred<AssessmentExamHistoryItem[]>();
        let readCount = 0;
        const listHistory = vi.fn(async () => {
            readCount += 1;
            if (readCount === 1) return firstHistory.promise;
            return createHistory();
        });
        const service = new ProgressService({
            catalogReader: {
                getConceptCatalog: () => createCatalog(["concept:rag"]),
            },
            masteryReader: {
                getState: () => createMasteryState({ stateCount: 1 }),
                getSnapshot: () => createSnapshot([createConceptState("concept:rag", "weak", 1)]),
            },
            assessmentSessionStore: { listHistory },
            getNow: () => readCount,
        });

        const pending = service.getSnapshot();
        service.invalidate();
        firstHistory.resolve(createHistory());

        await expect(pending).resolves.toMatchObject({ generatedAt: 2 });
        expect(listHistory).toHaveBeenCalledTimes(2);
        expect(service.getState()).toMatchObject({ dirty: false, generatedAt: 2 });
    });
});

function createCatalog(conceptIds: readonly string[]): LearningGraphConceptCatalog {
    return {
        concepts: conceptIds.map((id) => ({
            id,
            label: id,
            aliases: [],
            sourcePaths: [],
            sourceChunkIds: [],
        })),
        sourceReady: true,
        message: null,
    };
}

function createMasteryState(overrides: Partial<MasteryStateView> = {}): MasteryStateView {
    return {
        hasSnapshot: true,
        dirty: false,
        busy: false,
        lastError: null,
        algorithmVersion: "mastery/v1",
        stateCount: 4,
        sourceEventCount: 6,
        unboundIssueCount: 1,
        ...overrides,
    };
}

function createSnapshot(states: ConceptMasteryState[]): MasterySnapshotV1 {
    return {
        schemaVersion: 1,
        algorithmVersion: "mastery/v1",
        calculatedAt: 999,
        states,
        sourceEventCount: 6,
        unboundIssues: [{
            eventId: "event-unbound",
            sourceConceptId: "exam-topic:unknown",
            reason: "unknown-concept",
        }],
    };
}

function createConceptState(
    conceptId: string,
    level: ConceptMasteryState["level"],
    effectiveEvidenceCount: number,
): ConceptMasteryState {
    return {
        conceptId,
        masteryScore: effectiveEvidenceCount === 0 ? null : 0.7,
        confidence: effectiveEvidenceCount === 0 ? 0 : 0.8,
        level,
        assessmentCount: effectiveEvidenceCount,
        effectiveEvidenceCount,
        lastAssessedAt: effectiveEvidenceCount === 0 ? null : 800,
        lastReviewedAt: null,
        nextReviewAt: effectiveEvidenceCount === 0 ? null : 900,
        commonErrorCodes: [],
        trend: "stable",
        evidence: [],
        calculatedAt: 999,
        algorithmVersion: "mastery/v1",
    };
}

function createHistory(): AssessmentExamHistoryItem[] {
    return [{
        path: ".vault-coach/assessments/sessions/one.json",
        sessionId: "one",
        sessionPath: ".vault-coach/assessments/sessions/one.json",
        reportPath: null,
        title: "Scored assessment",
        createdAt: 10,
        score: 80,
        maxScore: 100,
        modifiedAt: 20,
    }, {
        path: ".vault-coach/assessments/sessions/two.json",
        sessionId: "two",
        sessionPath: ".vault-coach/assessments/sessions/two.json",
        reportPath: null,
        title: "Unscored assessment",
        createdAt: 30,
        score: null,
        maxScore: null,
        modifiedAt: null,
    }];
}

function createDeferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}
