import { describe, expect, it } from "vitest";
import { ConceptExtractionService } from "../../../src/app/semantic-graph/concept-extraction-service";
import { SemanticGraphService } from "../../../src/app/semantic-graph/semantic-graph-service";
import { createSectionConceptCandidateId } from "../../../src/domain/semantic-graph/concept-candidate-fingerprint";
import type { DocumentIndexReader } from "../../../src/domain/documents/document-index-reader";
import type { IndexedChunk } from "../../../src/domain/documents/document-types";
import type { GraphSnapshotV1 } from "../../../src/domain/graph/graph-types";
import type { SemanticGraphStore } from "../../../src/domain/semantic-graph/semantic-graph-store";
import { createEmptySemanticGraphState, type SemanticGraphState } from "../../../src/domain/semantic-graph/semantic-graph-types";
import { createDefaultSettings } from "../../../src/settings";

describe("SemanticGraphService", () => {
    it("builds evidence-backed candidates on explicit rebuild and promotes only confirmed relations", async () => {
        const store = new MemorySemanticStore();
        const sectionId = "section:doc:one";
        const retrievalCandidate = createSectionConceptCandidateId(sectionId, "retrieval");
        const rankingCandidate = createSectionConceptCandidateId(sectionId, "ranking");
        const service = new SemanticGraphService({
            graphService: { getSnapshot: () => snapshot(sectionId) } as never,
            documentIndex: reader() as DocumentIndexReader,
            store,
            extractionService: new ConceptExtractionService({
                generateJsonAnswer: async (messages) => messages[1]?.content.includes("已验证候选概念")
                    ? JSON.stringify({ relations: [{
                        type: "used_for",
                        source_candidate_id: retrievalCandidate,
                        target_candidate_id: rankingCandidate,
                        confidence: 0.9,
                        source_excerpt_ids: ["E1"],
                    }] })
                    : JSON.stringify({ concepts: [
                        { name: "Retrieval", aliases: ["RAG retrieval"], description: "Find relevant evidence.", source_excerpt_ids: ["E1"] },
                        { name: "Ranking", aliases: [], description: "Order evidence.", source_excerpt_ids: ["E1"] },
                    ] }),
            }),
            embeddingGateway: { embedTexts: async (texts) => texts.map((_text, index) => index === 0 ? [1, 0, 0] : [0, 1, 0]) },
            getSettings: () => ({ ...createDefaultSettings(), enableSemanticGraph: true, semanticGraphMaxSectionsPerRun: 10 }),
            getNow: () => 10,
        });
        await service.load();

        await service.rebuildAll();
        const projection = service.getReviewProjection();
        expect(projection.concepts).toHaveLength(2);
        expect(projection.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ type: "used_for", origin: "model" })]));
        expect(projection.relations).toEqual([]);
        const candidate = projection.candidates.find((item) => item.type === "used_for");
        if (!candidate) throw new Error("Expected relation candidate.");

        await service.confirmCandidate(candidate.fingerprint);
        expect(service.getReviewProjection().relations).toEqual([expect.objectContaining({ type: "used_for", origin: "model" })]);
        expect(store.state?.concepts[0]?.evidence[0]?.chunkId).toBe("chunk-1");

        const confirmDecision = store.state?.decisions.find((decision) => decision.kind === "confirm-candidate");
        if (!confirmDecision || confirmDecision.kind !== "confirm-candidate") throw new Error("Expected confirmation decision.");
        await service.undoCandidateDecision(confirmDecision.id);
        expect(service.getReviewProjection().relations).toEqual([]);
        expect(service.getReviewProjection().candidates).toEqual(expect.arrayContaining([expect.objectContaining({ fingerprint: candidate.fingerprint })]));

        const concepts = service.getReviewProjection().concepts;
        const source = concepts[0];
        const target = concepts[1];
        if (!source || !target) throw new Error("Expected two concepts.");
        await service.createManualRelation("used_for", source.id, target.id, undefined, "Reviewed manually.");
        const manualRelation = service.getReviewProjection().relations.find((relation) => relation.origin === "user");
        if (!manualRelation) throw new Error("Expected manual relationship.");
        await service.removeManualRelation(manualRelation.id);
        expect(service.getReviewProjection().relations).toEqual([]);
        const removalDecision = store.state?.decisions.find((decision) => decision.kind === "remove-manual-relation");
        if (!removalDecision || removalDecision.kind !== "remove-manual-relation") throw new Error("Expected manual removal decision.");
        await service.undoManualRelationRemoval(removalDecision.id);
        expect(service.getReviewProjection().relations).toEqual([expect.objectContaining({ id: manualRelation.id, origin: "user" })]);
    });

    it("keeps both endpoints of high-priority pending candidates in a bounded default review", async () => {
        const state = createEmptySemanticGraphState(10);
        state.concepts = Array.from({ length: 40 }, (_value, index) => reviewConcept(index));
        state.candidates = [{
            fingerprint: "candidate:tail-pair",
            type: "related_to",
            sourceConceptId: "concept:00000038",
            targetConceptId: "concept:00000039",
            confidence: 0.99,
            origin: "rule",
            evidence: [],
            model: null,
            createdAt: 10,
            updatedAt: 10,
        }];
        const service = new SemanticGraphService({
            graphService: {} as never,
            documentIndex: {} as never,
            store: new MemorySemanticStore(state),
            extractionService: {} as never,
            embeddingGateway: {} as never,
            getSettings: createDefaultSettings,
            getNow: () => 10,
        });
        await service.load();

        const projection = service.getReviewProjection({ limit: 36 });

        expect(projection.concepts.map((concept) => concept.id)).toEqual(expect.arrayContaining([
            "concept:00000038",
            "concept:00000039",
        ]));
        expect(projection.candidates).toEqual([expect.objectContaining({ fingerprint: "candidate:tail-pair" })]);
    });
});

function snapshot(sectionId: string): GraphSnapshotV1 {
    return {
        schemaVersion: 1,
        nodes: [{
            id: sectionId,
            type: "section",
            documentId: "doc",
            filePath: "notes/a.md",
            headingPath: ["A"],
            occurrence: 0,
            chunkIds: ["chunk-1"],
            locator: { type: "markdown", filePath: "notes/a.md", heading: "A" },
        }],
        edges: [],
        stats: { documentCount: 0, sectionCount: 1, tagCount: 0, edgeCount: 0 },
    };
}

function reader(): Pick<DocumentIndexReader, "getChunkById"> {
    const chunk: IndexedChunk = {
        id: "chunk-1",
        documentId: "doc",
        documentType: "markdown",
        filePath: "notes/a.md",
        fileName: "a.md",
        headingPath: ["A"],
        text: "Retrieval is used for ranking evidence.",
        searchableText: "Retrieval is used for ranking evidence.",
        locator: { type: "markdown", filePath: "notes/a.md", heading: "A" },
        contentKind: "native-text",
    };
    return { getChunkById: (id) => id === chunk.id ? chunk : null };
}

function reviewConcept(index: number) {
    const id = `concept:${index.toString().padStart(8, "0")}`;
    return {
        id,
        displayName: `Concept ${index}`,
        normalizedName: `concept ${index}`,
        aliases: [],
        description: "Test concept.",
        evidence: [{
            sectionId: "section:test",
            chunkId: `chunk:${index}`,
            locator: { type: "markdown" as const, filePath: "test.md" },
            excerptId: "E1",
            inputHash: "hash",
            textPreview: "test",
        }],
        sourceCandidateIds: [`candidate:${index}`],
        createdAt: 10,
        updatedAt: 10,
    };
}

class MemorySemanticStore implements SemanticGraphStore {
    constructor(public state: SemanticGraphState | null = null) {}
    async load(): Promise<SemanticGraphState | null> { return this.state; }
    async save(state: SemanticGraphState): Promise<void> { this.state = JSON.parse(JSON.stringify(state)) as SemanticGraphState; }
    async clear(): Promise<void> { this.state = createEmptySemanticGraphState(0); }
}
