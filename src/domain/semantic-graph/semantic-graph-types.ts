import type { DocumentLocator } from "../documents/document-types";
import type { GraphCapacityAssessment } from "../graph-capacity/graph-capacity-types";

/** 持久化语义图 schema 与 M2 `GraphSnapshotV1` 明确分离。 */
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

/** 模型提议始终绑定到提供证据的 Section。 */
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
 * Concept ID 标识一个有来源的概念，不代表名称相同的两个概念自动等同。
 * 合并始终是决策层事实。
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

/** 撤销一次确认或拒绝，但不修改既有审计日志。 */
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

/** 恢复曾记录为已删除的用户创建关系。 */
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

/**
 * 语义图持久化状态。抽取事实、候选和用户决策保持分离，
 * 投影时才应用确认、拒绝、合并和别名决策。
 */
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
 * 只读展示策略。不得写入确认决策，也不得参与 Mastery 或 Exam 计算。
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

/** 删除用户治理叠加层前展示的影响预览。 */
export interface SemanticGovernanceImpact {
    decisionCount: number;
    affectedConceptCount: number;
}

/** 仅存在于内存中的进度，不得与语义图事实一起持久化。 */
export interface SemanticGraphBuildProgress {
    /** 当前构建开始时需要模型处理的 Section 总数。 */
    totalSections: number;
    /** 所有抽取窗口均已成功完成的 Section 数。 */
    processedSections: number;
    /** 当前构建中尚未尝试的 Section 数。 */
    queuedSections: number;
    /** 已失败并将在后续重建中重试的 Section 数。 */
    failedSections: number;
}

/** 最近一次图任务中 Lite 来源过滤的内存报告。 */
export interface SemanticGraphSourceScope {
    includedFileCount: number;
    skippedFileCount: number;
    skippedFilePaths: string[];
}

/** 展示层可观察的语义图运行状态；构建进度和错误不属于持久化事实。 */
export interface SemanticGraphStateView {
    enabled: boolean;
    dirty: boolean;
    busy: boolean;
    hasData: boolean;
    lastError: string | null;
    stats: SemanticGraphStats;
    progress: SemanticGraphBuildProgress;
    sourceScope: SemanticGraphSourceScope;
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

/** 创建符合当前 schema 的空状态；时间戳由调用方注入以支持确定性测试。 */
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
