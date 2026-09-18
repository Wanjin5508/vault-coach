import { describe, expect, it } from "vitest";
import { buildRecommendations } from "../../../src/domain/recommendation/recommendation-planner";
import { RECOMMENDATION_ALGORITHM_VERSION } from "../../../src/domain/recommendation/recommendation-policy";

const generatedAt = 1_720_000_000_000;

describe("recommendation planner", () => {
    it("ranks only source-backed weak, due, and confirmed prerequisite concepts deterministically", () => {
        const input = {
            algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
            generatedAt,
            concepts: [
                { id: "weak", label: "Weak", sourceChunkIds: ["chunk-weak"], masteryScore: 0.2, confidence: 0.8, level: "weak" as const, assessmentCount: 2, lastAssessedAt: null, nextReviewAt: generatedAt - 1 },
                { id: "prerequisite", label: "Prerequisite", sourceChunkIds: ["chunk-prerequisite"], masteryScore: null, confidence: 0.2, level: "unknown" as const, assessmentCount: 0, lastAssessedAt: null, nextReviewAt: null },
                { id: "outside", label: "Outside", sourceChunkIds: [], masteryScore: null, confidence: 0, level: "unknown" as const, assessmentCount: 0, lastAssessedAt: null, nextReviewAt: null },
            ],
            prerequisites: [{ relationId: "r1", prerequisiteConceptId: "prerequisite", targetConceptId: "weak" }],
            actionEvents: [],
        };

        const first = buildRecommendations(input);
        expect(buildRecommendations(input)).toEqual(first);
        expect(first.map((item) => item.id)).toEqual([
            "recommendation:concept:weak",
            "recommendation:concept:prerequisite",
            "recommendation:prerequisite:prerequisite:weak",
        ]);
        expect(first.every((item) => !item.targetConceptIds.includes("outside"))).toBe(true);
    });

    it("preserves dismiss/defer facts without changing recommendation priority", () => {
        const base = {
            algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
            generatedAt,
            concepts: [{ id: "gap", label: "Gap", sourceChunkIds: ["chunk-gap"], masteryScore: null, confidence: 0, level: "unknown" as const, assessmentCount: 0, lastAssessedAt: null, nextReviewAt: null }],
            prerequisites: [],
        };
        const open = buildRecommendations({ ...base, actionEvents: [] })[0];
        const dismissed = buildRecommendations({ ...base, actionEvents: [{ id: "a1", recommendationId: "recommendation:concept:gap", action: "dismissed" as const, occurredAt: generatedAt }] })[0];
        expect(dismissed?.priority).toBe(open?.priority);
        expect(dismissed?.actionState).toBe("dismissed");
    });

    it("reopens a deferred recommendation only when its explicit defer date expires", () => {
        const base = {
            algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
            generatedAt,
            concepts: [{ id: "gap", label: "Gap", sourceChunkIds: ["chunk-gap"], masteryScore: null, confidence: 0, level: "unknown" as const, assessmentCount: 0, lastAssessedAt: null, nextReviewAt: null }],
            prerequisites: [],
        };
        const deferred = buildRecommendations({
            ...base,
            actionEvents: [{ id: "a1", recommendationId: "recommendation:concept:gap", action: "deferred" as const, occurredAt: generatedAt, deferUntil: generatedAt + 1 }],
        })[0];
        const noDate = buildRecommendations({
            ...base,
            actionEvents: [{ id: "a2", recommendationId: "recommendation:concept:gap", action: "deferred" as const, occurredAt: generatedAt }],
        })[0];

        expect(deferred?.actionState).toBe("deferred");
        expect(noDate?.actionState).toBe("deferred");
        expect(buildRecommendations({ ...base, generatedAt: generatedAt + 2, actionEvents: [{ id: "a1", recommendationId: "recommendation:concept:gap", action: "deferred" as const, occurredAt: generatedAt, deferUntil: generatedAt + 1 }] })[0]?.actionState).toBe("open");
    });

    it("does not duplicate a prerequisite recommendation when equivalent effective relations exist", () => {
        const recommendations = buildRecommendations({
            algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
            generatedAt,
            concepts: [
                { id: "foundation", label: "Foundation", sourceChunkIds: ["chunk-foundation"], masteryScore: 0.7, confidence: 0.7, level: "proficient" as const, assessmentCount: 1, lastAssessedAt: null, nextReviewAt: null },
                { id: "advanced", label: "Advanced", sourceChunkIds: ["chunk-advanced"], masteryScore: 0.1, confidence: 0.8, level: "weak" as const, assessmentCount: 1, lastAssessedAt: null, nextReviewAt: null },
            ],
            prerequisites: [
                { relationId: "manual", prerequisiteConceptId: "foundation", targetConceptId: "advanced" },
                { relationId: "confirmed", prerequisiteConceptId: "foundation", targetConceptId: "advanced" },
            ],
            actionEvents: [],
        });

        expect(recommendations.filter((item) => item.kind === "review-prerequisite")).toHaveLength(1);
    });

    it("uses bounded confirmed prerequisite connectivity as an explicit local importance signal", () => {
        const recommendations = buildRecommendations({
            algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
            generatedAt,
            concepts: [
                { id: "hub", label: "Hub", sourceChunkIds: ["hub#1"], masteryScore: null, confidence: 0.7, level: "unknown" as const, assessmentCount: 0, lastAssessedAt: null, nextReviewAt: null },
                { id: "target-a", label: "Target A", sourceChunkIds: ["a#1"], masteryScore: 0.2, confidence: 0.8, level: "weak" as const, assessmentCount: 1, lastAssessedAt: null, nextReviewAt: null },
                { id: "target-b", label: "Target B", sourceChunkIds: ["b#1"], masteryScore: 0.2, confidence: 0.8, level: "weak" as const, assessmentCount: 1, lastAssessedAt: null, nextReviewAt: null },
            ],
            prerequisites: [
                { relationId: "a", prerequisiteConceptId: "hub", targetConceptId: "target-a" },
                { relationId: "b", prerequisiteConceptId: "hub", targetConceptId: "target-b" },
            ],
            actionEvents: [],
        });

        const hub = recommendations.find((item) => item.id === "recommendation:concept:hub");
        expect(hub?.priority).toBe(310);
        expect(hub?.reasonCodes).toContain("high-connectivity");
    });
});
