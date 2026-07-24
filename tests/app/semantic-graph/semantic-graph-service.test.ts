import { describe, expect, it, vi } from "vitest";
import { ConceptExtractionService } from "../../../src/app/semantic-graph/concept-extraction-service";
import { SemanticGraphService } from "../../../src/app/semantic-graph/semantic-graph-service";
import { createSectionConceptCandidateId } from "../../../src/domain/semantic-graph/concept-candidate-fingerprint";
import type { DocumentIndexReader } from "../../../src/domain/documents/document-index-reader";
import type { IndexedChunk } from "../../../src/domain/documents/document-types";
import type { GraphSnapshotV1 } from "../../../src/domain/graph/graph-types";
import type { SemanticGraphStore } from "../../../src/domain/semantic-graph/semantic-graph-store";
import { createEmptySemanticGraphState, type SectionExtractionRecord, type SemanticGraphState, type SemanticModelMetadata } from "../../../src/domain/semantic-graph/semantic-graph-types";
import { createDefaultSettings } from "../../../src/settings";
import type { SectionExtractionInput } from "../../../src/app/semantic-graph/section-extraction-input";

describe("SemanticGraphService", () => {
    it("exhausts every pending Section in fair document rounds and persists each checkpoint", async () => {
        const store = new MemorySemanticStore();
        const extracted: string[] = [];
        const service = new SemanticGraphService({
            graphService: { getSnapshot: () => multiSectionSnapshot() } as never,
            documentIndex: multiSectionReader() as DocumentIndexReader,
            store,
            extractionService: {
                extract: async (input: SectionExtractionInput, model: SemanticModelMetadata): Promise<SectionExtractionRecord> => {
                    extracted.push(`${input.documentPath}:${input.headingPath.join(" > ")}`);
                    return emptyExtraction(input, model);
                },
            } as never,
            embeddingGateway: { embedTexts: async () => [] },
            getSettings: () => ({ ...createDefaultSettings(), enableSemanticGraph: true, semanticGraphMaxSectionsPerRun: 1 }),
            getNow: () => 10,
        });
        await service.load();

        await service.rebuildAll();

        // A second section in 00 must not prevent the first Section of 01 from
        // entering the first two durable batches.
        expect(extracted).toEqual([
            "00-overview.md:Overview one",
            "01-topic.md:Topic",
            "00-overview.md:Overview two",
        ]);
        expect(store.state?.extractions).toHaveLength(3);
        expect(store.saveCount).toBeGreaterThanOrEqual(4);
        expect(service.getState().progress).toEqual({
            totalSections: 3,
            processedSections: 3,
            queuedSections: 0,
            failedSections: 0,
        });
    });

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

        expect(service.getGovernanceImpact()).toMatchObject({
            decisionCount: 5,
            affectedConceptCount: 2,
        });

        await service.resetGovernanceDecisions();
        expect(store.state?.decisions).toEqual([]);
        expect(store.state?.concepts).toHaveLength(2);
        expect(store.state?.embeddings).toHaveLength(2);
        expect(service.getReviewProjection().relations).toEqual([]);
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

    it("pauses automatic semantic sync at the local warning budget without changing existing graph reads", async () => {
        const service = new SemanticGraphService({
            graphService: { getSnapshot: () => null } as never,
            documentIndex: {
                getStats: () => ({ fileCount: 20, chunkCount: 8_001, lastIndexedAt: 1, scopeDescription: "test" }),
                getFileRecords: () => [],
            } as never,
            store: new MemorySemanticStore(),
            extractionService: {} as never,
            embeddingGateway: {} as never,
            getSettings: () => ({ ...createDefaultSettings(), enableSemanticGraph: true, enableSemanticGraphAutoSync: true }),
        });
        await service.load();

        await service.syncChangedFiles({ affectedFiles: ["notes/changed.md"] });

        expect(service.getState().capacity).toMatchObject({
            level: "warning",
            allowManualSemanticBuild: true,
            allowAutomaticSemanticSync: false,
        });
        expect(service.getReviewProjection()).toMatchObject({ concepts: [], relations: [], candidates: [] });
    });

    it("refuses a manual rebuild above the 500 semantic-window Lite limit", async () => {
        const extract = vi.fn();
        const service = new SemanticGraphService({
            graphService: { getSnapshot: () => capacitySnapshot(501) } as never,
            documentIndex: capacityReader() as DocumentIndexReader,
            store: new MemorySemanticStore(),
            extractionService: { extract } as never,
            embeddingGateway: { embedTexts: async () => [] },
            getSettings: () => ({ ...createDefaultSettings(), enableSemanticGraph: true }),
        });
        await service.load();

        await expect(service.rebuildAll()).rejects.toThrow("semantic-input-count=501");
        expect(extract).not.toHaveBeenCalled();
    });

    it("skips Lite-large sources by default and processes them only after an explicit opt-in", async () => {
        let includeLargeFiles = false;
        const extracted: string[] = [];
        const stateChanged = vi.fn();
        const service = new SemanticGraphService({
            graphService: { getSnapshot: () => largeFileSnapshot() } as never,
            documentIndex: largeFileReader() as DocumentIndexReader,
            store: new MemorySemanticStore(),
            extractionService: {
                extract: async (input: SectionExtractionInput, model: SemanticModelMetadata): Promise<SectionExtractionRecord> => {
                    extracted.push(input.documentPath);
                    return emptyExtraction(input, model);
                },
            } as never,
            embeddingGateway: { embedTexts: async () => [] },
            getSettings: () => ({
                ...createDefaultSettings(),
                enableSemanticGraph: true,
                semanticGraphMaxSectionsPerRun: 1,
                semanticGraphIncludeLargeFiles: includeLargeFiles,
            }),
            onStateChanged: stateChanged,
            getNow: () => 10,
        });
        await service.load();

        await service.rebuildAll();
        expect(extracted).toEqual(["notes/normal.md"]);
        expect(service.getState().sourceScope).toMatchObject({
            includedFileCount: 1,
            skippedFileCount: 2,
            skippedFilePaths: ["notes/large.md", "notes/large.pdf"],
        });
        expect(stateChanged).toHaveBeenCalled();

        includeLargeFiles = true;
        await service.rebuildAll();
        expect(extracted).toEqual(["notes/normal.md", "notes/large.md", "notes/large.pdf"]);
        expect(service.getState().sourceScope).toMatchObject({ skippedFileCount: 0 });
    });

    it("prunes stale source-derived semantic facts while retaining the user decision audit", async () => {
        const store = new MemorySemanticStore();
        let currentSnapshot = snapshot("section:doc:one");
        const sectionId = "section:doc:one";
        const retrievalCandidate = createSectionConceptCandidateId(sectionId, "retrieval");
        const rankingCandidate = createSectionConceptCandidateId(sectionId, "ranking");
        const service = new SemanticGraphService({
            graphService: { getSnapshot: () => currentSnapshot } as never,
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
                        { name: "Retrieval", aliases: [], description: "Find evidence.", source_excerpt_ids: ["E1"] },
                        { name: "Ranking", aliases: [], description: "Order evidence.", source_excerpt_ids: ["E1"] },
                    ] }),
            }),
            embeddingGateway: { embedTexts: async (texts) => texts.map((_text, index) => index === 0 ? [1, 0] : [0, 1]) },
            getSettings: () => ({ ...createDefaultSettings(), enableSemanticGraph: true, semanticGraphMaxSectionsPerRun: 10 }),
            getNow: () => 10,
        });
        await service.load();
        await service.rebuildAll();
        const candidate = service.getReviewProjection().candidates.find((item) => item.type === "used_for");
        if (!candidate) throw new Error("Expected a candidate to confirm.");
        await service.confirmCandidate(candidate.fingerprint);

        // The same file's source Section changed while the plugin was offline.
        // Its new input hash invalidates the old extraction without invoking a model.
        currentSnapshot = snapshot("section:doc:replacement");
        await service.reconcileWithCurrentSources();

        expect(store.state).toMatchObject({
            extractions: [],
            concepts: [],
            candidates: [],
            embeddings: [],
            decisions: [expect.objectContaining({ kind: "confirm-candidate" })],
        });
        expect(service.getReviewProjection().relations).toEqual([]);
        const stateView = service.getState();
        expect(stateView.dirty).toBe(true);
        expect(stateView.lastError ?? "").toContain("知识来源已变更");
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

function multiSectionSnapshot(): GraphSnapshotV1 {
    return {
        schemaVersion: 1,
        nodes: [
            section("section:00:one", "doc:00", "00-overview.md", "Overview one", "chunk:00:one"),
            section("section:00:two", "doc:00", "00-overview.md", "Overview two", "chunk:00:two"),
            section("section:01:topic", "doc:01", "01-topic.md", "Topic", "chunk:01:topic"),
        ],
        edges: [],
        stats: { documentCount: 0, sectionCount: 3, tagCount: 0, edgeCount: 0 },
    };
}

function largeFileSnapshot(): GraphSnapshotV1 {
    return {
        schemaVersion: 1,
        nodes: [
            section("section:large", "doc:large", "notes/large.md", "Large", "chunk:large"),
            section("section:pdf", "doc:pdf", "notes/large.pdf", "Large PDF", "chunk:pdf"),
            section("section:normal", "doc:normal", "notes/normal.md", "Normal", "chunk:normal"),
        ],
        edges: [],
        stats: { documentCount: 3, sectionCount: 3, tagCount: 0, edgeCount: 0 },
    };
}

function capacitySnapshot(count: number): GraphSnapshotV1 {
    return {
        schemaVersion: 1,
        nodes: Array.from({ length: count }, (_value, index) => section(
            `section:capacity:${index}`,
            "doc:capacity",
            "notes/capacity.md",
            `Capacity ${index}`,
            `chunk:capacity:${index}`,
        )),
        edges: [],
        stats: { documentCount: 1, sectionCount: count, tagCount: 0, edgeCount: 0 },
    };
}

function section(id: string, documentId: string, filePath: string, heading: string, chunkId: string): GraphSnapshotV1["nodes"][number] {
    return {
        id,
        type: "section",
        documentId,
        filePath,
        headingPath: [heading],
        occurrence: 0,
        chunkIds: [chunkId],
        locator: { type: "markdown", filePath, heading },
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

function multiSectionReader(): Pick<DocumentIndexReader, "getChunkById"> {
    const chunks = [
        indexedChunk("chunk:00:one", "doc:00", "00-overview.md", "Overview one"),
        indexedChunk("chunk:00:two", "doc:00", "00-overview.md", "Overview two"),
        indexedChunk("chunk:01:topic", "doc:01", "01-topic.md", "Topic"),
    ];
    return { getChunkById: (id) => chunks.find((chunk) => chunk.id === id) ?? null };
}

function largeFileReader(): Pick<DocumentIndexReader, "getChunkById" | "getFileRecord" | "readDocumentText"> {
    const chunks: IndexedChunk[] = [
        indexedChunk("chunk:large", "doc:large", "notes/large.md", "Large"),
        {
            ...indexedChunk("chunk:pdf", "doc:pdf", "notes/large.pdf", "Large PDF"),
            documentType: "pdf" as const,
            locator: { type: "pdf" as const, filePath: "notes/large.pdf", pageStart: 1 },
        },
        indexedChunk("chunk:normal", "doc:normal", "notes/normal.md", "Normal"),
    ];
    return {
        getChunkById: (id) => chunks.find((chunk) => chunk.id === id) ?? null,
        getFileRecord: (path) => ({
            filePath: path,
            documentType: path.endsWith(".pdf") ? "pdf" : "markdown",
            contentHash: path,
            ...(path.endsWith(".pdf") ? { fileSize: 20 * 1024 * 1024 + 1 } : {}),
            chunkIds: chunks.filter((chunk) => chunk.filePath === path).map((chunk) => chunk.id),
            indexedAt: 1,
        }),
        readDocumentText: async (path) => path === "notes/large.md" ? "x".repeat(60_001) : "normal source",
    };
}

function capacityReader(): Pick<DocumentIndexReader, "getChunkById"> {
    return {
        getChunkById: (id) => {
            const match = /^chunk:capacity:(\d+)$/.exec(id);
            if (!match) return null;
            const index = Number.parseInt(match[1] ?? "0", 10);
            return indexedChunk(id, "doc:capacity", "notes/capacity.md", `Capacity ${index}`);
        },
    };
}

function indexedChunk(id: string, documentId: string, filePath: string, heading: string): IndexedChunk {
    return {
        id,
        documentId,
        documentType: "markdown",
        filePath,
        fileName: filePath,
        headingPath: [heading],
        text: `${heading} content`,
        searchableText: `${heading} content`,
        locator: { type: "markdown", filePath, heading },
        contentKind: "native-text",
    };
}

function emptyExtraction(input: SectionExtractionInput, model: SemanticModelMetadata): SectionExtractionRecord {
    return {
        id: input.id,
        documentId: input.documentId,
        documentPath: input.documentPath,
        sectionId: input.sectionId,
        headingPath: [...input.headingPath],
        inputHash: input.inputHash,
        extractorSignature: `${model.provider}:${model.modelName}:${model.promptVersion}:${model.schemaVersion}`,
        candidates: [],
        relations: [],
        updatedAt: model.generatedAt,
        lastError: null,
        model: { ...model },
    };
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
    saveCount = 0;
    constructor(public state: SemanticGraphState | null = null) {}
    async load(): Promise<SemanticGraphState | null> { return this.state; }
    async save(state: SemanticGraphState): Promise<void> {
        this.saveCount += 1;
        this.state = JSON.parse(JSON.stringify(state)) as SemanticGraphState;
    }
    async clear(): Promise<void> { this.state = createEmptySemanticGraphState(0); }
}
