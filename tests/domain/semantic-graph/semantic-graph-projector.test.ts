import { describe, expect, it } from "vitest";
import { SemanticGraphProjector } from "../../../src/domain/semantic-graph/semantic-graph-projector";
import { createEmptySemanticGraphState, type SemanticConcept, type SemanticGraphState } from "../../../src/domain/semantic-graph/semantic-graph-types";

describe("SemanticGraphProjector", () => {
    it("keeps unconfirmed candidates out, honours reversible decisions, and makes merge reversible", () => {
        const state = createState();
        const projector = new SemanticGraphProjector();
        expect(projector.project(state).relations).toEqual([]);

        state.decisions.push({ id: "decision-confirm", kind: "confirm-candidate", candidateFingerprint: "candidate:relation:one", createdAt: 2 });
        expect(projector.project(state).relations).toEqual([expect.objectContaining({ type: "related_to" })]);

        state.decisions.push({ id: "decision-reject", kind: "reject-candidate", candidateFingerprint: "candidate:relation:one", createdAt: 3 });
        expect(projector.project(state).relations).toEqual([]);

        state.decisions.push({ id: "decision-undo-reject", kind: "undo-candidate-decision", supersedesDecisionId: "decision-reject", createdAt: 4 });
        expect(projector.project(state).relations).toEqual([expect.objectContaining({ type: "related_to" })]);

        state.decisions.push({ id: "decision-merge", kind: "merge-concepts", canonicalConceptId: "concept:a", mergedConceptIds: ["concept:b"], createdAt: 5 });
        expect(projector.project(state).redirects).toEqual({ "concept:b": "concept:a" });
        expect(projector.project(state).concepts.map((concept) => concept.id)).toEqual(["concept:a"]);

        state.decisions.push({ id: "decision-undo", kind: "undo-merge", supersedesDecisionId: "decision-merge", createdAt: 6 });
        expect(projector.project(state).concepts.map((concept) => concept.id)).toEqual(["concept:a", "concept:b"]);
    });

    it("restores a deleted manual relation through an append-only undo decision", () => {
        const state = createState();
        const projector = new SemanticGraphProjector();
        state.decisions.push({
            id: "decision-create-manual",
            kind: "create-manual-relation",
            relationId: "relation:user:one",
            type: "used_for",
            sourceConceptId: "concept:a",
            targetConceptId: "concept:b",
            note: "User reviewed this relation.",
            createdAt: 2,
        });
        expect(projector.project(state).relations).toEqual([expect.objectContaining({ id: "relation:user:one", origin: "user" })]);

        state.decisions.push({ id: "decision-remove-manual", kind: "remove-manual-relation", relationId: "relation:user:one", createdAt: 3 });
        expect(projector.project(state).relations).toEqual([]);

        state.decisions.push({ id: "decision-undo-remove-manual", kind: "undo-manual-relation-removal", supersedesDecisionId: "decision-remove-manual", createdAt: 4 });
        expect(projector.project(state).relations).toEqual([expect.objectContaining({ id: "relation:user:one", origin: "user" })]);
    });
});

function createState(): SemanticGraphState {
    const state = createEmptySemanticGraphState(1);
    state.concepts = [concept("concept:a", "Alpha"), concept("concept:b", "Beta")];
    state.candidates = [{
        fingerprint: "candidate:relation:one",
        type: "related_to",
        sourceConceptId: "concept:a",
        targetConceptId: "concept:b",
        confidence: 0.9,
        origin: "model",
        evidence: [evidence("chunk-a")],
        model: null,
        createdAt: 1,
        updatedAt: 1,
    }];
    return state;
}

function concept(id: string, displayName: string): SemanticConcept {
    return {
        id,
        displayName,
        normalizedName: displayName.toLowerCase(),
        aliases: [],
        description: displayName,
        evidence: [evidence(`chunk-${displayName}`)],
        sourceCandidateIds: [`candidate:${id}`],
        createdAt: 1,
        updatedAt: 1,
    };
}

function evidence(chunkId: string) {
    return {
        sectionId: "section:one",
        chunkId,
        locator: { type: "markdown" as const, filePath: "notes/a.md", heading: "A" },
        excerptId: "E1",
        inputHash: "hash",
        textPreview: "Evidence text",
    };
}
