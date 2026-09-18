import { describe, expect, it } from "vitest";
import { createAdaptivePlanInputFingerprint } from "../../../src/domain/adaptive-exam/adaptive-exam-fingerprint";
import { validateAdaptiveExamPlan } from "../../../src/domain/adaptive-exam/adaptive-exam-integrity";
import { buildAdaptiveExamPlan } from "../../../src/domain/adaptive-exam/adaptive-exam-planner";
import { ADAPTIVE_EXAM_ALGORITHM_VERSION } from "../../../src/domain/adaptive-exam/adaptive-exam-policy";
import type { AdaptiveExamPlanningInput } from "../../../src/domain/adaptive-exam/adaptive-exam-types";

function createInput(overrides: Partial<AdaptiveExamPlanningInput> = {}): AdaptiveExamPlanningInput {
    return {
        algorithmVersion: ADAPTIVE_EXAM_ALGORITHM_VERSION,
        planningAt: 1_720_000_000_000,
        scope: { signature: "scope-a", eligibleChunkIds: ["chunk-a", "chunk-b", "chunk-prerequisite"] },
        examMode: "simple",
        targetMode: "diagnostic",
        requestedQuestionCount: 3,
        revisions: {
            indexRevision: "index-a",
            effectiveGraphRevision: "graph-a",
            masteryRevision: "mastery-a",
            assessmentRevision: "assessment-a",
        },
        concepts: [
            {
                id: "concept-unassessed",
                label: "Unassessed",
                sourceChunkIds: ["chunk-a"],
                masteryScore: null,
                confidence: 0.1,
                level: "unknown",
                assessmentCount: 0,
                lastAssessedAt: null,
                nextReviewAt: null,
            },
            {
                id: "concept-weak",
                label: "Weak target",
                sourceChunkIds: ["chunk-b"],
                masteryScore: 0.25,
                confidence: 0.8,
                level: "weak",
                assessmentCount: 2,
                lastAssessedAt: 1_700_000_000_000,
                nextReviewAt: 1_710_000_000_000,
            },
            {
                id: "concept-prerequisite",
                label: "Prerequisite",
                sourceChunkIds: ["chunk-prerequisite"],
                masteryScore: 0.6,
                confidence: 0.7,
                level: "developing",
                assessmentCount: 1,
                lastAssessedAt: 1_690_000_000_000,
                nextReviewAt: null,
            },
            {
                id: "concept-outside-scope",
                label: "Outside scope",
                sourceChunkIds: ["outside"],
                masteryScore: null,
                confidence: 0,
                level: "unknown",
                assessmentCount: 0,
                lastAssessedAt: null,
                nextReviewAt: null,
            },
        ],
        confirmedPrerequisites: [{
            relationId: "relation-prerequisite",
            prerequisiteConceptId: "concept-prerequisite",
            targetConceptId: "concept-weak",
        }],
        ...overrides,
    };
}

describe("adaptive exam domain planner", () => {
    it("creates a deterministic, source-bounded diagnostic plan", () => {
        const input = createInput();
        const first = buildAdaptiveExamPlan(input);
        const second = buildAdaptiveExamPlan(input);

        expect(second).toEqual(first);
        expect(first.targets[0]).toMatchObject({
            conceptId: "concept-unassessed",
            sourceChunkIds: ["chunk-a"],
        });
        expect(first.targets.map((target) => target.conceptId)).not.toContain("concept-outside-scope");
        expect(first.diagnostics.excludedConceptIds).toEqual(["concept-outside-scope"]);
        expect(first.diagnostics.plannedQuestionCount).toBe(3);
        expect(validateAdaptiveExamPlan(first)).toEqual([]);
    });

    it("selects only confirmed, in-scope prerequisites for prerequisite mode", () => {
        const plan = buildAdaptiveExamPlan(createInput({ targetMode: "prerequisite", requestedQuestionCount: 1 }));

        expect(plan.targets).toEqual([expect.objectContaining({
            conceptId: "concept-prerequisite",
            reasonCodes: ["confirmed-prerequisite"],
            prerequisiteOfConceptIds: ["concept-weak"],
            sourceChunkIds: ["chunk-prerequisite"],
        })]);
    });

    it("falls back to diagnostics when no confirmed prerequisite can be used", () => {
        const plan = buildAdaptiveExamPlan(createInput({ targetMode: "prerequisite", confirmedPrerequisites: [] }));

        expect(plan.appliedFallbacks).toContain("insufficient-evidence");
        expect(plan.targets[0]?.conceptId).toBe("concept-unassessed");
    });

    it("includes both exam dimensions and revisions in a plan fingerprint", () => {
        const base = createInput();
        expect(createAdaptivePlanInputFingerprint({ ...base, examMode: "challenge" }))
            .not.toBe(createAdaptivePlanInputFingerprint(base));
        expect(createAdaptivePlanInputFingerprint({
            ...base,
            revisions: { ...base.revisions, masteryRevision: "mastery-b" },
        })).not.toBe(createAdaptivePlanInputFingerprint(base));
    });
});
