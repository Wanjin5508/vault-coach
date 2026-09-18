import { describe, expect, it } from "vitest";
import {
    createKnowledgeChangeV1,
    createKnowledgeEngineIdempotencyKey,
} from "../../../src/app/engine/knowledge-engine-dto-adapter";

describe("Knowledge Engine DTO adapter", () => {
    it("creates a versioned, immutable confirmed-graph export with an idempotency key", () => {
        const aliases = ["retrieval augmented generation"];
        const evidenceChunkIds = ["chunk:rag:1"];
        const change = createKnowledgeChangeV1({
            workspaceId: "workspace-1",
            sourceId: "graph-effective",
            revision: 7,
            kind: "confirmed-graph-facts",
            operation: "upsert",
            contentHash: "hash-1",
            occurredAt: 100,
            payload: {
                concepts: [{ id: "concept:rag", label: "RAG", aliases }],
                relations: [{
                    id: "relation:rag:retrieval",
                    sourceConceptId: "concept:retrieval",
                    targetConceptId: "concept:rag",
                    type: "part_of",
                    trust: "confirmed",
                    evidenceChunkIds,
                }],
            },
        });
        aliases.push("mutated");
        evidenceChunkIds.push("mutated");

        expect(change).toMatchObject({ schemaVersion: 1, protocolVersion: 1, payload: {
            concepts: [{ aliases: ["retrieval augmented generation"] }],
            relations: [{ evidenceChunkIds: ["chunk:rag:1"] }],
        } });
        expect(createKnowledgeEngineIdempotencyKey(change)).toBe("workspace-1:graph-effective:7");
    });

    it("rejects content without explicit authorization and non-confirmed graph relations", () => {
        const base = {
            workspaceId: "workspace-1",
            sourceId: "source-1",
            revision: 1,
            operation: "upsert" as const,
            contentHash: "hash",
            occurredAt: 1,
        };

        expect(() => createKnowledgeChangeV1({
            ...base,
            kind: "content-change",
            payload: { sourceLocator: { filePath: "notes/private.md" }, content: "private", contentAuthorized: false, byteLength: 7 },
        })).toThrow("explicit user authorization");
        expect(() => createKnowledgeChangeV1({
            ...base,
            kind: "confirmed-graph-facts",
            payload: {
                concepts: [],
                relations: [{ id: "candidate", sourceConceptId: "a", targetConceptId: "b", type: "related_to", trust: "automatic" as never, evidenceChunkIds: [] }],
            },
        })).toThrow("only exports confirmed graph relations");
    });

    it("requires delete events to contain no payload", () => {
        expect(() => createKnowledgeChangeV1({
            workspaceId: "workspace-1",
            sourceId: "source-1",
            revision: 2,
            kind: "assessment-evidence",
            operation: "delete",
            contentHash: null,
            occurredAt: 2,
            payload: { eventId: "event-1", conceptId: "concept:rag", normalizedScore: 0.5, occurredAt: 1, revision: 1 },
        })).toThrow("delete changes must not include a payload");
    });
});
