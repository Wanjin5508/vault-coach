import { describe, expect, it } from "vitest";
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
});

function createCatalog(conceptIds: readonly string[]): LearningGraphConceptCatalog {
    return {
        concepts: conceptIds.map((id) => ({
            id,
            label: id,
            aliases: [],
            sourcePaths: [],
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
