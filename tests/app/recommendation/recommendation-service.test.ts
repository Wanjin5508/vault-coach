import { describe, expect, it } from "vitest";
import { RecommendationService } from "../../../src/app/recommendation/recommendation-service";
import type { ReviewActionEvent } from "../../../src/domain/recommendation/recommendation-types";

describe("RecommendationService", () => {
    it("derives source-backed recommendations and invalidates only its disposable snapshot after an action", async () => {
        const actions: ReviewActionEvent[] = [];
        let nextId = 0;
        const service = new RecommendationService({
            learningGraph: {
                getConceptCatalog: () => ({
                    sourceReady: true,
                    message: null,
                    concepts: [{ id: "concept:rag", label: "RAG", aliases: [], sourcePaths: ["rag.md"], sourceChunkIds: ["rag#1"] }],
                }),
                getConfirmedPrerequisites: () => [],
            },
            mastery: {
                getSnapshot: () => ({
                    schemaVersion: 1,
                    algorithmVersion: "mastery/v2",
                    calculatedAt: 10,
                    sourceEventCount: 1,
                    unboundIssues: [],
                    states: [{
                        conceptId: "concept:rag", masteryScore: 0.2, confidence: 0.8, level: "weak", assessmentCount: 1,
                        effectiveEvidenceCount: 1, lastAssessedAt: 10, lastReviewedAt: null, nextReviewAt: null,
                        commonErrorCodes: [], trend: "stable", evidence: [], calculatedAt: 10, algorithmVersion: "mastery/v2",
                    }],
                }),
            },
            actionStore: {
                list: async () => actions.map((action) => ({ ...action })),
                append: async (action) => { actions.push({ ...action }); },
            },
            createEventId: () => `action-${nextId++}`,
            now: () => 100,
        });

        const first = await service.getSnapshot();
        expect(first.primary.map((item) => item.id)).toEqual(["recommendation:concept:concept:rag"]);
        expect(first.primary[0]?.actionState).toBe("open");

        await service.recordAction("recommendation:concept:concept:rag", "completed");
        const afterCompletion = await service.getSnapshot();

        expect(actions).toMatchObject([{ action: "completed", recommendationId: "recommendation:concept:concept:rag", occurredAt: 100 }]);
        expect(afterCompletion.primary).toEqual([]);
        expect(afterCompletion.queue[0]).toMatchObject({ actionState: "completed", priority: first.queue[0]?.priority });
    });
});
