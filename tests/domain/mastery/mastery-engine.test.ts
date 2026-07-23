import { describe, expect, it } from "vitest";
import { MasteryEngine } from "../../../src/domain/mastery/mastery-engine";
import type { AssessmentConceptBinding, AssessmentEvent } from "../../../src/domain/assessment/assessment-types";
import type { LearningGraphConceptCatalog } from "../../../src/domain/learning-graph/learning-graph-types";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("MasteryEngine", () => {
    it("computes only active, traceable evidence and retains unknown concepts without evidence", () => {
        const engine = new MasteryEngine();
        const result = engine.calculateAll({
            catalog: catalog(),
            now: DAY_MS * 10,
            assessments: [
                input(event("old-alpha", { conceptIds: ["exam-topic:alpha"], normalizedScore: 0.1, occurredAt: 0 })),
                input(event("alpha", {
                    conceptIds: ["exam-topic:alpha"], normalizedScore: 0.9, difficulty: "advanced", occurredAt: DAY_MS * 10,
                    supersedesEventId: "old-alpha", errorCodes: ["missing-key-point"],
                })),
                input(event("beta", { conceptIds: ["concept:beta"], normalizedScore: 0.6, occurredAt: DAY_MS * 10 })),
                input(event("ambiguous", { conceptIds: ["exam-topic:shared"], sourceChunkIds: ["chunk:ambiguous"], occurredAt: DAY_MS * 10 }), [binding("exam-topic:shared", "Shared")]),
                input(event("unknown", { conceptIds: ["exam-topic:unknown"], sourceChunkIds: ["chunk:unknown"], occurredAt: DAY_MS * 10 }), [binding("exam-topic:unknown", "Not in graph")]),
            ],
        });

        expect(result.sourceEventCount).toBe(4);
        const alpha = result.states.find((state) => state.conceptId === "concept:alpha");
        expect(alpha).toMatchObject({
            level: "mastered",
            assessmentCount: 1,
            effectiveEvidenceCount: 1,
            commonErrorCodes: ["missing-key-point"],
            nextReviewAt: DAY_MS * 31,
            evidence: [expect.objectContaining({ eventId: "alpha", bindingKind: "exact-display-name" })],
        });
        expect(alpha?.masteryScore).toBeCloseTo(0.9);
        expect(result.states.find((state) => state.conceptId === "concept:beta")).toMatchObject({
            masteryScore: 0.6,
            level: "developing",
            nextReviewAt: DAY_MS * 13,
            evidence: [expect.objectContaining({ bindingKind: "direct-concept-id" })],
        });
        expect(result.states.find((state) => state.conceptId === "concept:gamma")).toMatchObject({
            masteryScore: null,
            confidence: 0,
            level: "unknown",
            nextReviewAt: null,
        });
        expect(result.unboundIssues).toEqual([
            { eventId: "ambiguous", sourceConceptId: "exam-topic:shared", reason: "ambiguous-label", candidateConceptIds: ["concept:alpha", "concept:beta"] },
            { eventId: "unknown", sourceConceptId: "exam-topic:unknown", reason: "unknown-concept" },
        ]);
    });

    it("uses recency-weighted evidence deterministically and reports a trend only with enough evidence", () => {
        const engine = new MasteryEngine();
        const inputEvents = [
            input(event("early", { conceptIds: ["concept:alpha"], normalizedScore: 0.2, occurredAt: 0 })),
            input(event("late", { conceptIds: ["concept:alpha"], normalizedScore: 1, occurredAt: DAY_MS * 10 })),
        ];
        const first = engine.calculateAll({ catalog: catalog(), assessments: inputEvents, now: DAY_MS * 10 });
        const second = engine.calculateAll({ catalog: catalog(), assessments: [...inputEvents].reverse(), now: DAY_MS * 10 });
        const alpha = first.states.find((state) => state.conceptId === "concept:alpha");

        expect(first).toEqual(second);
        expect(alpha).toMatchObject({ trend: "improving", assessmentCount: 2, effectiveEvidenceCount: 2 });
        expect(alpha?.masteryScore).toBeGreaterThan(0.2);
        expect(alpha?.masteryScore).toBeLessThan(1);
    });

    it("rebinds legacy provisional Exam topics through exact source chunk evidence", () => {
        const result = new MasteryEngine().calculateAll({
            catalog: catalog(),
            now: DAY_MS,
            assessments: [input(
                event("legacy-empty-answer", {
                    conceptIds: ["exam-topic:legacy"],
                    sourceChunkIds: ["chunk-1", "chunk-2"],
                    normalizedScore: 0,
                    occurredAt: DAY_MS,
                }),
                [binding("exam-topic:legacy", "A chapter title that is not a concept")],
            )],
        });

        expect(result.unboundIssues).toEqual([]);
        expect(result.states.find((state) => state.conceptId === "concept:alpha")).toMatchObject({
            level: "weak",
            evidence: [expect.objectContaining({ bindingKind: "source-chunk-evidence", normalizedScore: 0 })],
        });
        expect(result.states.find((state) => state.conceptId === "concept:beta")).toMatchObject({
            level: "weak",
            evidence: [expect.objectContaining({ bindingKind: "source-chunk-evidence", normalizedScore: 0 })],
        });
    });
});

function catalog(): LearningGraphConceptCatalog {
    return {
        sourceReady: true,
        message: null,
        concepts: [
            { id: "concept:alpha", label: "Alpha", aliases: ["Shared"], sourcePaths: ["notes/a.md"], sourceChunkIds: ["chunk-1"] },
            { id: "concept:beta", label: "Beta", aliases: ["Shared", "B"], sourcePaths: ["notes/b.md"], sourceChunkIds: ["chunk-2"] },
            { id: "concept:gamma", label: "Gamma", aliases: [], sourcePaths: ["notes/c.md"], sourceChunkIds: ["chunk-3"] },
        ],
    };
}

function input(eventValue: AssessmentEvent, bindings: AssessmentConceptBinding[] = [binding("exam-topic:alpha", "Alpha")]) {
    return { event: eventValue, conceptBindings: bindings };
}

function binding(id: string, label: string): AssessmentConceptBinding {
    return { id, label, sourceBlueprintItemId: "blueprint-1", kind: "provisional-topic" };
}

function event(id: string, overrides: Partial<AssessmentEvent> = {}): AssessmentEvent {
    return {
        id,
        eventType: "exam-answer",
        sessionId: `session-${id}`,
        questionId: `question-${id}`,
        conceptIds: ["concept:alpha"],
        sourceChunkIds: ["chunk-1"],
        rawScore: 80,
        normalizedScore: 0.8,
        difficulty: "intermediate",
        questionType: "explanation",
        errorCodes: [],
        evidenceConfidence: 1,
        evaluationConfidence: 1,
        occurredAt: 0,
        evaluator: { provider: "test", model: "test", promptVersion: "test/v1" },
        ...overrides,
    };
}
