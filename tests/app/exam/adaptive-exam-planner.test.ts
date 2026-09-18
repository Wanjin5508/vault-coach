import { describe, expect, it } from "vitest";
import { AdaptiveExamPlanner } from "../../../src/app/exam/adaptive-exam-planner";
import type { AdaptiveExamPlanRequest } from "../../../src/domain/adaptive-exam/adaptive-exam-types";
import type { MasteryStateView } from "../../../src/domain/mastery/mastery-types";

function createRequest(): AdaptiveExamPlanRequest {
    return {
        selection: { selectedFolderPaths: [], excludedFilePaths: [], forceIncludedFilePaths: [] },
        analysis: {
            selection: { selectedFolderPaths: [], excludedFilePaths: [], forceIncludedFilePaths: [] },
            profiles: [],
            summary: {
                totalFiles: 1,
                ruleExcludedFiles: 0,
                manualExcludedFiles: 0,
                semanticExcludedFiles: 0,
                partialFiles: 0,
                includedFiles: 1,
                eligibleChunkCount: 1,
                estimatedMinQuestions: 1,
                estimatedMaxQuestions: 3,
                cacheHits: 0,
                cacheMisses: 0,
            },
            eligibleChunkIds: ["chunk-a"],
            promptVersion: "scope/v1",
        },
        questionCount: 2,
        examMode: "simple",
        targetMode: "diagnostic",
    };
}

function createMasteryState(): MasteryStateView {
    return {
        hasSnapshot: false,
        dirty: false,
        busy: false,
        lastError: null,
        algorithmVersion: null,
        stateCount: 0,
        sourceEventCount: 0,
        unboundIssueCount: 0,
    };
}

describe("AdaptiveExamPlanner", () => {
    it("assembles only effective, source-backed facts and rejects a stale graph revision", async () => {
        let revision = "graph/v1";
        const planner = new AdaptiveExamPlanner({
            learningGraph: {
                getConceptCatalog: () => ({
                    sourceReady: true,
                    message: null,
                    concepts: [{
                        id: "concept-a",
                        label: "Concept A",
                        aliases: [],
                        sourcePaths: ["notes/a.md"],
                        sourceChunkIds: ["chunk-a", "chunk-outside"],
                    }],
                }),
                getConfirmedPrerequisites: () => [],
                getRevision: () => revision,
            },
            mastery: {
                getSnapshot: () => null,
                getState: createMasteryState,
            },
            assessmentSessionStore: { list: async () => [] },
            now: () => 1_720_000_000_000,
        });

        const request = createRequest();
        const result = await planner.preview(request);

        expect(result.status).toBe("degraded");
        if (result.status === "unavailable") throw new Error("Expected a plan.");
        expect(result.plan.targets).toEqual([expect.objectContaining({
            conceptId: "concept-a",
            sourceChunkIds: ["chunk-a"],
            expectedQuestionCount: 1,
        })]);

        const context = {
            planId: result.plan.id,
            algorithmVersion: result.plan.algorithmVersion,
            inputFingerprint: result.plan.inputFingerprint,
            revisionFingerprint: result.plan.revisionFingerprint,
            targetMode: result.plan.targetMode,
            examMode: result.plan.examMode,
            scopeSignature: result.plan.scopeSignature,
            revisions: result.plan.revisions,
            targets: result.plan.targets,
            appliedFallbacks: result.plan.appliedFallbacks,
        };
        await expect(planner.isCurrent(context, request)).resolves.toBe(true);
        revision = "graph/v2";
        await expect(planner.isCurrent(context, request)).resolves.toBe(false);
    });
});
