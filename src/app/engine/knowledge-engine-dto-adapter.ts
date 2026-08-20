import { KNOWLEDGE_ENGINE_PROTOCOL_VERSION } from "./knowledge-engine-types";

export const KNOWLEDGE_CHANGE_SCHEMA_VERSION = 1 as const;
export type KnowledgeChangeKind = "content-change" | "confirmed-graph-facts" | "assessment-evidence" | "knowledge-profile-candidate";
export type KnowledgeChangeOperation = "upsert" | "delete";

export interface EngineSourceLocatorV1 {
    filePath: string;
    heading?: string;
    chunkId?: string;
}

/** Raw section text is allowed only when a future caller obtained explicit consent. */
export interface ContentChangePayloadV1 {
    sourceLocator: EngineSourceLocatorV1;
    content: string | null;
    contentAuthorized: boolean;
    byteLength: number;
}

export interface ConfirmedGraphConceptPayloadV1 {
    id: string;
    label: string;
    aliases: readonly string[];
}

export interface ConfirmedGraphRelationPayloadV1 {
    id: string;
    sourceConceptId: string;
    targetConceptId: string;
    type: string;
    /** Only a confirmed/user-governed relation can cross this boundary. */
    trust: "confirmed" | "user";
    evidenceChunkIds: readonly string[];
}

export interface ConfirmedGraphFactsPayloadV1 {
    concepts: readonly ConfirmedGraphConceptPayloadV1[];
    relations: readonly ConfirmedGraphRelationPayloadV1[];
}

/** Minimal evidence for batch computation; answers, rubrics, and note text are excluded. */
export interface AssessmentEvidencePayloadV1 {
    eventId: string;
    conceptId: string | null;
    normalizedScore: number | null;
    occurredAt: number;
    revision: number;
}

export interface KnowledgeProfileCandidatePayloadV1 {
    candidateId: string;
    consent: "granted";
    conceptIds: readonly string[];
    masterySummary: Readonly<Record<string, number | null>>;
}

export type KnowledgeChangePayloadV1 =
    | ContentChangePayloadV1
    | ConfirmedGraphFactsPayloadV1
    | AssessmentEvidencePayloadV1
    | KnowledgeProfileCandidatePayloadV1;

export interface KnowledgeChangeV1 {
    schemaVersion: typeof KNOWLEDGE_CHANGE_SCHEMA_VERSION;
    protocolVersion: typeof KNOWLEDGE_ENGINE_PROTOCOL_VERSION;
    workspaceId: string;
    sourceId: string;
    revision: number;
    kind: KnowledgeChangeKind;
    operation: KnowledgeChangeOperation;
    contentHash: string | null;
    occurredAt: number;
    payload: KnowledgeChangePayloadV1 | null;
}

export interface CreateKnowledgeChangeInput {
    workspaceId: string;
    sourceId: string;
    revision: number;
    kind: KnowledgeChangeKind;
    operation: KnowledgeChangeOperation;
    contentHash: string | null;
    occurredAt: number;
    payload: KnowledgeChangePayloadV1 | null;
}

/**
 * Creates a safe, transport-neutral V1 change. The adapter intentionally
 * rejects unsanctioned content and non-confirmed graph relations before any
 * future Local client can serialize or transmit the data.
 */
export function createKnowledgeChangeV1(input: CreateKnowledgeChangeInput): KnowledgeChangeV1 {
    validateIdentity("workspaceId", input.workspaceId);
    validateIdentity("sourceId", input.sourceId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Knowledge Engine revision must be a positive safe integer.");
    if (!Number.isFinite(input.occurredAt) || input.occurredAt < 0) throw new Error("Knowledge Engine occurredAt must be a valid timestamp.");
    if (input.contentHash !== null && input.contentHash.trim().length === 0) throw new Error("Knowledge Engine contentHash must be null or non-empty.");
    if (input.operation === "delete") {
        if (input.payload !== null) throw new Error("Knowledge Engine delete changes must not include a payload.");
    } else {
        validatePayload(input.kind, input.payload);
    }
    return {
        schemaVersion: KNOWLEDGE_CHANGE_SCHEMA_VERSION,
        protocolVersion: KNOWLEDGE_ENGINE_PROTOCOL_VERSION,
        workspaceId: input.workspaceId.trim(),
        sourceId: input.sourceId.trim(),
        revision: input.revision,
        kind: input.kind,
        operation: input.operation,
        contentHash: input.contentHash?.trim() || null,
        occurredAt: Math.floor(input.occurredAt),
        payload: input.payload === null ? null : clonePayload(input.kind, input.payload),
    };
}

export function createKnowledgeEngineIdempotencyKey(change: Pick<KnowledgeChangeV1, "workspaceId" | "sourceId" | "revision">): string {
    return `${change.workspaceId}:${change.sourceId}:${change.revision}`;
}

function validatePayload(kind: KnowledgeChangeKind, payload: KnowledgeChangePayloadV1 | null): asserts payload is KnowledgeChangePayloadV1 {
    if (!payload) throw new Error(`Knowledge Engine ${kind} upsert requires a payload.`);
    switch (kind) {
        case "content-change":
            validateContentPayload(payload as ContentChangePayloadV1);
            return;
        case "confirmed-graph-facts":
            validateGraphPayload(payload as ConfirmedGraphFactsPayloadV1);
            return;
        case "assessment-evidence":
            validateAssessmentPayload(payload as AssessmentEvidencePayloadV1);
            return;
        case "knowledge-profile-candidate":
            validateProfilePayload(payload as KnowledgeProfileCandidatePayloadV1);
    }
}

function validateContentPayload(payload: ContentChangePayloadV1): void {
    validateIdentity("sourceLocator.filePath", payload.sourceLocator?.filePath ?? "");
    if (!Number.isSafeInteger(payload.byteLength) || payload.byteLength < 0) throw new Error("Knowledge Engine content byteLength must be non-negative.");
    if (payload.content !== null && !payload.contentAuthorized) {
        throw new Error("Knowledge Engine content requires explicit user authorization.");
    }
}

function validateGraphPayload(payload: ConfirmedGraphFactsPayloadV1): void {
    for (const concept of payload.concepts) validateIdentity("concept.id", concept.id);
    for (const relation of payload.relations) {
        validateIdentity("relation.id", relation.id);
        validateIdentity("relation.sourceConceptId", relation.sourceConceptId);
        validateIdentity("relation.targetConceptId", relation.targetConceptId);
        if (relation.trust !== "confirmed" && relation.trust !== "user") {
            throw new Error("Knowledge Engine only exports confirmed graph relations.");
        }
    }
}

function validateAssessmentPayload(payload: AssessmentEvidencePayloadV1): void {
    validateIdentity("assessment.eventId", payload.eventId);
    if (payload.conceptId !== null) validateIdentity("assessment.conceptId", payload.conceptId);
    if (payload.normalizedScore !== null && (!Number.isFinite(payload.normalizedScore) || payload.normalizedScore < 0 || payload.normalizedScore > 1)) {
        throw new Error("Knowledge Engine normalized score must be between zero and one.");
    }
    if (!Number.isFinite(payload.occurredAt) || payload.occurredAt < 0) throw new Error("Knowledge Engine assessment timestamp is invalid.");
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 1) throw new Error("Knowledge Engine assessment revision is invalid.");
}

function validateProfilePayload(payload: KnowledgeProfileCandidatePayloadV1): void {
    validateIdentity("profile.candidateId", payload.candidateId);
    if (payload.consent !== "granted") throw new Error("Knowledge Engine profile export requires explicit consent.");
    payload.conceptIds.forEach((id) => validateIdentity("profile.conceptId", id));
}

function validateIdentity(label: string, value: string): void {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
        throw new Error(`Knowledge Engine ${label} must be a non-empty bounded string.`);
    }
}

function clonePayload(kind: KnowledgeChangeKind, payload: KnowledgeChangePayloadV1): KnowledgeChangePayloadV1 {
    switch (kind) {
        case "content-change": {
            const value = payload as ContentChangePayloadV1;
            return {
                sourceLocator: { ...value.sourceLocator },
                content: value.content,
                contentAuthorized: value.contentAuthorized,
                byteLength: value.byteLength,
            };
        }
        case "confirmed-graph-facts": {
            const value = payload as ConfirmedGraphFactsPayloadV1;
            return {
                concepts: value.concepts.map((concept) => ({ ...concept, aliases: [...concept.aliases] })),
                relations: value.relations.map((relation) => ({ ...relation, evidenceChunkIds: [...relation.evidenceChunkIds] })),
            };
        }
        case "assessment-evidence":
            return { ...(payload as AssessmentEvidencePayloadV1) };
        case "knowledge-profile-candidate": {
            const value = payload as KnowledgeProfileCandidatePayloadV1;
            return {
                candidateId: value.candidateId,
                consent: value.consent,
                conceptIds: [...value.conceptIds],
                masterySummary: { ...value.masterySummary },
            };
        }
    }
}
