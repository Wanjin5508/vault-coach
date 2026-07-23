import type { DocumentLocator } from "../documents/document-types";
import type { GraphCapacityAssessment } from "../graph-capacity/graph-capacity-types";

/** The persisted semantic graph schema is deliberately separate from M2 GraphSnapshotV1. */
export const SEMANTIC_GRAPH_SCHEMA_VERSION = 1;
export const SEMANTIC_EXTRACTION_SCHEMA_VERSION = "concept-extraction/v1";

export type SemanticRelationType =
    | "same_as"
    | "part_of"
    | "prerequisite_of"
    | "used_for"
    | "contrasts_with"
    | "related_to";

export type SemanticCandidateOrigin = "model" | "rule" | "similarity";
export type SemanticRelationOrigin = SemanticCandidateOrigin | "user";

export interface ConceptEvidenceRef {
    sectionId: string;
    chunkId: string;
    locator: DocumentLocator;
    excerptId: string;
    inputHash: string;
    textPreview: string;
}

export interface SemanticModelMetadata {
    provider: "ollama" | "openai-compatible";
    modelName: string;
    promptVersion: string;
    schemaVersion: string;
    generatedAt: number;
}

/** A model proposal remains attached to the Section that supplied its evidence. */
export interface SectionConceptCandidate {
    id: string;
    name: string;
    normalizedName: string;
    aliases: string[];
    description: string;
    evidence: ConceptEvidenceRef[];
}

export interface SectionRelationProposal {
    type: Exclude<SemanticRelationType, "same_as">;
    sourceCandidateId: string;
    targetCandidateId: string;
    confidence: number;
    evidence: ConceptEvidenceRef[];
}

export interface SectionExtractionRecord {
    id: string;
    documentId: string;
    documentPath: string;
    sectionId: string;
    headingPath: string[];
    inputHash: string;
    extractorSignature: string;
    candidates: SectionConceptCandidate[];
    relations: SectionRelationProposal[];
    updatedAt: number;
    lastError: string | null;
    model: SemanticModelMetadata | null;
}

/**
 * Concept IDs identify a source-backed notion, not an automatic claim that two
 * equally named notions are identical.  Merges are always decision-layer facts.
 */
export interface SemanticConcept {
    id: string;
    displayName: string;
    normalizedName: string;
    aliases: string[];
    description: string;
    evidence: ConceptEvidenceRef[];
    sourceCandidateIds: string[];
    createdAt: number;
    updatedAt: number;
}

export interface SemanticCandidate {
    fingerprint: string;
    type: SemanticRelationType;
    sourceConceptId: string;
    targetConceptId: string;
    confidence: number;
    origin: SemanticCandidateOrigin;
    evidence: ConceptEvidenceRef[];
    model: SemanticModelMetadata | null;
    sourceSectionId?: string;
    createdAt: number;
    updatedAt: number;
}

export interface ConfirmCandidateDecision {
    id: string;
    kind: "confirm-candidate";
    candidateFingerprint: string;
    createdAt: number;
}

export interface RejectCandidateDecision {
    id: string;
    kind: "reject-candidate";
    candidateFingerprint: string;
    reason?: string;
    createdAt: number;
}

/** Reverses one confirmation or rejection without mutating the audit log. */
export interface UndoCandidateDecision {
    id: string;
    kind: "undo-candidate-decision";
    supersedesDecisionId: string;
    createdAt: number;
}

export interface MergeConceptsDecision {
    id: string;
    kind: "merge-concepts";
    canonicalConceptId: string;
    mergedConceptIds: string[];
    createdAt: number;
}

export interface UndoMergeDecision {
    id: string;
    kind: "undo-merge";
    supersedesDecisionId: string;
    createdAt: number;
}

export interface AliasDecision {
    id: string;
    kind: "add-alias" | "remove-alias";
    conceptId: string;
    alias: string;
    createdAt: number;
}

export interface ManualRelationDecision {
    id: string;
    kind: "create-manual-relation";
    relationId: string;
    type: SemanticRelationType;
    sourceConceptId: string;
    targetConceptId: string;
    evidence?: ConceptEvidenceRef[];
    note?: string;
    createdAt: number;
}

export interface RemoveManualRelationDecision {
    id: string;
    kind: "remove-manual-relation";
    relationId: string;
    createdAt: number;
}

/** Restores a user-created relation whose removal was previously recorded. */
export interface UndoManualRelationRemovalDecision {
    id: string;
    kind: "undo-manual-relation-removal";
    supersedesDecisionId: string;
    createdAt: number;
}

export type UserSemanticDecision =
    | ConfirmCandidateDecision
    | RejectCandidateDecision
    | UndoCandidateDecision
    | MergeConceptsDecision
    | UndoMergeDecision
    | AliasDecision
    | ManualRelationDecision
    | RemoveManualRelationDecision
    | UndoManualRelationRemovalDecision;

type WithoutDecisionIdentity<T> = T extends { id: string; createdAt: number }
    ? Omit<T, "id" | "createdAt">
    : never;

export type UserSemanticDecisionInput = WithoutDecisionIdentity<UserSemanticDecision>;

export interface SemanticEmbeddingRecord {
    conceptId: string;
    modelSignature: string;
    inputHash: string;
    vector: number[];
    updatedAt: number;
}

export interface SemanticGraphState {
    schemaVersion: typeof SEMANTIC_GRAPH_SCHEMA_VERSION;
    extractions: SectionExtractionRecord[];
    concepts: SemanticConcept[];
    candidates: SemanticCandidate[];
    decisions: UserSemanticDecision[];
    embeddings: SemanticEmbeddingRecord[];
    updatedAt: number;
}

export interface EffectiveSemanticRelation {
    id: string;
    type: SemanticRelationType;
    sourceConceptId: string;
    targetConceptId: string;
    confidence: number;
    origin: SemanticRelationOrigin;
    evidence: ConceptEvidenceRef[];
    candidateFingerprint?: string;
    decisionId?: string;
}

export interface EffectiveSemanticGraph {
    concepts: SemanticConcept[];
    relations: EffectiveSemanticRelation[];
    redirects: Record<string, string>;
    rejectedCandidateFingerprints: string[];
}

/**
 * Read-only display policy. It must never write confirmation decisions or be
 * used by Mastery/Exam calculations.
 */
export interface SemanticAutoRelationPolicy {
    enabled: boolean;
    modelMinConfidence: number;
    includeRuleRelations: boolean;
    includeSimilarityRelations: boolean;
}

export interface SemanticGraphStats {
    extractionCount: number;
    conceptCount: number;
    candidateCount: number;
    confirmedRelationCount: number;
    rejectedCandidateCount: number;
    pendingCandidateCount: number;
    embeddingCount: number;
}

/** Preview shown before removing the user-authored governance overlay. */
export interface SemanticGovernanceImpact {
    decisionCount: number;
    affectedConceptCount: number;
}

/** In-memory progress only; never persisted with semantic graph facts. */
export interface SemanticGraphBuildProgress {
    processedSections: number;
    queuedSections: number;
    failedSections: number;
}

export interface SemanticGraphStateView {
    enabled: boolean;
    dirty: boolean;
    busy: boolean;
    hasData: boolean;
    lastError: string | null;
    stats: SemanticGraphStats;
    progress: SemanticGraphBuildProgress;
    capacity: GraphCapacityAssessment;
}

export interface ConceptReviewQuery {
    search?: string;
    conceptId?: string;
    includePending?: boolean;
    limit?: number;
}

export interface ConceptReviewProjection {
    concepts: SemanticConcept[];
    relations: EffectiveSemanticRelation[];
    candidates: SemanticCandidate[];
    redirects: Record<string, string>;
    decisions: UserSemanticDecision[];
    stats: SemanticGraphStats;
}

export function createEmptySemanticGraphState(now = Date.now()): SemanticGraphState {
    return {
        schemaVersion: SEMANTIC_GRAPH_SCHEMA_VERSION,
        extractions: [],
        concepts: [],
        candidates: [],
        decisions: [],
        embeddings: [],
        updatedAt: now,
    };
}
