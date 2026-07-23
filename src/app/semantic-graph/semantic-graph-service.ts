import { createRelationCandidateFingerprint, createSemanticConceptId, isUndirectedRelation, stableSemanticHash } from "../../domain/semantic-graph/concept-candidate-fingerprint";
import { normalizeConceptAliases, normalizeConceptName } from "../../domain/semantic-graph/concept-normalizer";
import { SemanticGraphIntegrityService } from "../../domain/semantic-graph/semantic-graph-integrity";
import { SemanticGraphProjector } from "../../domain/semantic-graph/semantic-graph-projector";
import type { SemanticGraphStore } from "../../domain/semantic-graph/semantic-graph-store";
import {
    createEmptySemanticGraphState,
    type ConceptReviewProjection,
    type ConceptReviewQuery,
    type SemanticCandidate,
    type SemanticConcept,
    type SemanticEmbeddingRecord,
    type SemanticGraphState,
    type SemanticGraphStateView,
    type SemanticGraphStats,
    type SemanticModelMetadata,
    type SemanticRelationType,
    type ConceptEvidenceRef,
    type EffectiveSemanticGraph,
    type UserSemanticDecision,
    type UserSemanticDecisionInput,
} from "../../domain/semantic-graph/semantic-graph-types";
import type { KnowledgeBaseSyncResult } from "../../domain/documents/document-types";
import type { DocumentIndexReader } from "../../domain/documents/document-index-reader";
import type { VaultCoachSettings } from "../config/settings-types";
import type { KnowledgeGraphService } from "../graph/knowledge-graph-service";
import { ConceptExtractionService, CONCEPT_EXTRACTION_PROMPT_VERSION } from "./concept-extraction-service";
import {
    BoundedLshConceptSimilarityIndex,
    type ConceptEmbeddingRecord,
    type ConceptSimilarityIndex,
} from "./concept-similarity-index";
import { SemanticIndexCoordinator } from "./semantic-index-coordinator";
import { createSectionExtractionInputs, type SectionExtractionInput } from "./section-extraction-input";
import { assessGraphCapacity } from "../../domain/graph-capacity/graph-capacity-assessment";
import type { GraphCapacityAssessment, GraphCapacityInput } from "../../domain/graph-capacity/graph-capacity-types";
import type { VectorIndexStats } from "../../domain/retrieval/retrieval-types";

export interface SemanticEmbeddingGateway {
    embedTexts(texts: string[], options?: { allowWhenVectorRetrievalDisabled?: boolean }): Promise<number[][]>;
}

export interface SemanticGraphServiceDependencies {
    graphService: KnowledgeGraphService;
    documentIndex: DocumentIndexReader;
    store: SemanticGraphStore;
    extractionService: ConceptExtractionService;
    embeddingGateway: SemanticEmbeddingGateway;
    getSettings(): VaultCoachSettings;
    similarityIndex?: ConceptSimilarityIndex;
    getNow?(): number;
    getVectorIndexStats?(): Pick<VectorIndexStats, "vectorCount" | "dimension">;
}

/**
 * Coordinates optional model-backed semantic work while keeping M2 graph facts
 * and all Ask/Exam paths independent from failures in this service.
 */
export class SemanticGraphService {
    private readonly integrity = new SemanticGraphIntegrityService();
    private readonly projector = new SemanticGraphProjector();
    private readonly coordinator = new SemanticIndexCoordinator();
    private readonly similarityIndex: ConceptSimilarityIndex;
    private state: SemanticGraphState = createEmptySemanticGraphState(0);
    private dirty = false;
    private lastError: string | null = null;
    private similarityInitialized = false;

    constructor(private readonly dependencies: SemanticGraphServiceDependencies) {
        this.similarityIndex = dependencies.similarityIndex ?? new BoundedLshConceptSimilarityIndex();
    }

    async load(): Promise<void> {
        try {
            const loaded = await this.dependencies.store.load();
            this.state = loaded ?? createEmptySemanticGraphState(this.now());
            this.assertIntegrity(this.state);
            await this.similarityIndex.rebuild(this.state.embeddings.map(toConceptEmbeddingRecord));
            this.similarityInitialized = true;
            this.dirty = false;
            this.lastError = null;
        } catch (error: unknown) {
            this.state = createEmptySemanticGraphState(this.now());
            this.dirty = true;
            this.lastError = describeError(error);
            this.similarityInitialized = false;
        }
    }

    async rebuildAll(signal?: AbortSignal): Promise<void> {
        await this.run(undefined, signal, "manual");
    }

    async syncChangedFiles(syncResult: Pick<KnowledgeBaseSyncResult, "affectedFiles">, signal?: AbortSignal): Promise<void> {
        const settings = this.dependencies.getSettings();
        if (!settings.enableSemanticGraph || !settings.enableSemanticGraphAutoSync) return;
        const affected = new Set(syncResult.affectedFiles);
        if (affected.size === 0) return;
        if (!this.getCapacityAssessment().allowAutomaticSemanticSync) return;
        await this.run(affected, signal, "automatic");
    }

    abort(): void {
        this.coordinator.abort();
    }

    async clear(): Promise<void> {
        this.coordinator.abort();
        await this.dependencies.store.clear();
        await this.similarityIndex.clear();
        this.similarityInitialized = false;
        this.state = createEmptySemanticGraphState(this.now());
        this.dirty = false;
        this.lastError = null;
    }

    getState(): SemanticGraphStateView {
        return {
            enabled: this.dependencies.getSettings().enableSemanticGraph,
            dirty: this.dirty,
            busy: this.coordinator.isBusy(),
            hasData: this.state.concepts.length > 0 || this.state.candidates.length > 0,
            lastError: this.lastError,
            stats: this.getStats(),
            progress: this.coordinator.getProgress(),
            capacity: this.getCapacityAssessment(),
        };
    }

    /** Stable read boundary for M4A/M4B; pending and rejected candidates stay out. */
    getEffectiveGraph(): EffectiveSemanticGraph {
        return deepClone(this.projector.project(this.state));
    }

    /**
     * Display-only candidates for Learning Map. They are deliberately kept
     * outside getEffectiveGraph(), so downstream learning facts remain based
     * on explicit user decisions.
     */
    getAutoDisplayRelations(): EffectiveSemanticGraph["relations"] {
        const settings = this.dependencies.getSettings();
        return deepClone(this.projector.projectAutoDisplayRelations(this.state, {
            enabled: settings.learningMapAutoRelationsEnabled,
            modelMinConfidence: settings.learningMapAutoModelThreshold,
            includeRuleRelations: settings.learningMapAutoIncludeRuleRelations,
            includeSimilarityRelations: settings.learningMapAutoIncludeSimilarityRelations,
        }));
    }

    /**
     * A cheap cache revision for presentation projections.  `updatedAt` alone
     * is insufficient because multiple decisions may happen in one clock tick.
     * The policy portion also makes setting changes visible immediately, even
     * when a caller only refreshes the view and does not explicitly invalidate
     * the LearningGraphQueryService cache.
     */
    getLearningMapRevision(): string {
        const settings = this.dependencies.getSettings();
        return [
            this.state.updatedAt,
            this.state.concepts.length,
            this.state.candidates.length,
            this.state.decisions.length,
            settings.learningMapAutoRelationsEnabled ? "auto" : "manual",
            settings.learningMapAutoModelThreshold,
            settings.learningMapAutoIncludeRuleRelations ? "rule" : "no-rule",
            settings.learningMapAutoIncludeSimilarityRelations ? "similarity" : "no-similarity",
        ].join(":");
    }

    /** A local-only policy result; it never scans the Vault or calls a model. */
    getCapacityAssessment(): GraphCapacityAssessment {
        const snapshot = this.dependencies.graphService.getSnapshot();
        // Older test doubles and third-party read adapters may predate file
        // metadata. Missing metadata is reported as unknown, never treated as
        // an empty or safe Vault.
        const files = typeof this.dependencies.documentIndex.getFileRecords === "function"
            ? this.dependencies.documentIndex.getFileRecords()
            : null;
        const knownFileSizes = files?.map((file) => file.fileSize) ?? [];
        const indexedTextBytes = files === null
            ? null
            : knownFileSizes.length === 0
                ? 0
                : knownFileSizes.every((size): size is number => typeof size === "number" && Number.isFinite(size) && size >= 0)
                    ? knownFileSizes.reduce((total, size) => total + (size ?? 0), 0)
                    : null;
        const vectorStats = this.dependencies.getVectorIndexStats?.();
        const effective = this.projector.project(this.state);
        const indexStats = typeof this.dependencies.documentIndex.getStats === "function"
            ? this.dependencies.documentIndex.getStats()
            : null;
        const input: GraphCapacityInput = {
            fileCount: indexStats?.fileCount ?? null,
            chunkCount: indexStats?.chunkCount ?? null,
            documentCount: snapshot?.stats.documentCount ?? null,
            sectionCount: snapshot?.stats.sectionCount ?? null,
            structuralEdgeCount: snapshot?.stats.edgeCount ?? null,
            indexedTextBytes,
            extractionCount: this.state.extractions.length,
            conceptCount: this.state.concepts.length,
            candidateCount: this.state.candidates.length,
            effectiveRelationCount: effective.relations.length,
            embeddingCount: this.state.embeddings.length,
            vectorCount: vectorStats?.vectorCount ?? null,
            vectorDimension: vectorStats?.dimension ?? null,
        };
        return assessGraphCapacity(input);
    }

    getReviewProjection(query: ConceptReviewQuery = {}): ConceptReviewProjection {
        const effective = this.projector.project(this.state);
        const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 80)));
        const rejected = new Set(effective.rejectedCandidateFingerprints);
        const confirmed = new Set(effective.relations.map((relation) => relation.candidateFingerprint).filter((value): value is string => !!value));
        const effectiveConceptIds = new Set(effective.concepts.map((concept) => concept.id));
        const pendingCandidates = query.includePending === false
            ? []
            : this.state.candidates
                .filter((candidate) => !rejected.has(candidate.fingerprint) && !confirmed.has(candidate.fingerprint))
                // A candidate referring to a merged-away source concept is still
                // retained in the decision log, but cannot be drawn as an edge in
                // the effective review graph until it is re-proposed.
                .filter((candidate) => effectiveConceptIds.has(candidate.sourceConceptId) && effectiveConceptIds.has(candidate.targetConceptId))
                .sort(compareCandidatePriority);
        const visibleIds = this.getVisibleConceptIds(effective.concepts, effective.relations, pendingCandidates, query, limit);
        const maxRelationEdges = Math.max(1, limit * 2);
        const candidates = pendingCandidates
            // The force graph only draws complete edges. Keeping both endpoints
            // here prevents a "selected but invisible" candidate in its inspector.
            .filter((candidate) => visibleIds.has(candidate.sourceConceptId) && visibleIds.has(candidate.targetConceptId))
            .slice(0, maxRelationEdges)
            .map(cloneCandidate);
        return {
            concepts: effective.concepts.filter((concept) => visibleIds.has(concept.id)).map(cloneConcept),
            relations: effective.relations
                .filter((relation) => visibleIds.has(relation.sourceConceptId) && visibleIds.has(relation.targetConceptId))
                .slice(0, maxRelationEdges)
                .map((relation) => deepClone(relation)),
            candidates,
            redirects: { ...effective.redirects },
            decisions: this.state.decisions.slice(-100).map((decision) => deepClone(decision)),
            stats: this.getStats(),
        };
    }

    async confirmCandidate(candidateFingerprint: string): Promise<void> {
        if (!this.state.candidates.some((candidate) => candidate.fingerprint === candidateFingerprint)) {
            throw new Error("找不到要确认的语义关系候选。");
        }
        await this.appendDecision({ kind: "confirm-candidate", candidateFingerprint });
    }

    async rejectCandidate(candidateFingerprint: string, reason?: string): Promise<void> {
        if (!this.state.candidates.some((candidate) => candidate.fingerprint === candidateFingerprint)) {
            throw new Error("找不到要拒绝的语义关系候选。");
        }
        await this.appendDecision({ kind: "reject-candidate", candidateFingerprint, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
    }

    async undoCandidateDecision(decisionId: string): Promise<void> {
        const target = this.state.decisions.find((decision) => decision.id === decisionId);
        if (!target || (target.kind !== "confirm-candidate" && target.kind !== "reject-candidate")) {
            throw new Error("找不到可撤销的候选关系决策。");
        }
        const undone = new Set(this.state.decisions
            .filter((decision) => decision.kind === "undo-candidate-decision")
            .map((decision) => decision.supersedesDecisionId));
        if (undone.has(decisionId)) {
            throw new Error("该候选关系决策已经撤销。");
        }
        const currentDecision = this.state.decisions
            .filter((decision): decision is Extract<UserSemanticDecision, { kind: "confirm-candidate" | "reject-candidate" }> => (
                (decision.kind === "confirm-candidate" || decision.kind === "reject-candidate")
                && decision.candidateFingerprint === target.candidateFingerprint
                && !undone.has(decision.id)
            ))
            .at(-1);
        if (currentDecision?.id !== decisionId) {
            throw new Error("只能撤销该候选关系当前生效的决策。");
        }
        await this.appendDecision({ kind: "undo-candidate-decision", supersedesDecisionId: decisionId });
    }

    async mergeConcepts(canonicalConceptId: string, mergedConceptIds: readonly string[]): Promise<void> {
        const concepts = new Set(this.state.concepts.map((concept) => concept.id));
        const merged = Array.from(new Set(mergedConceptIds)).filter((conceptId) => conceptId !== canonicalConceptId);
        if (!concepts.has(canonicalConceptId) || merged.length === 0 || merged.some((conceptId) => !concepts.has(conceptId))) {
            throw new Error("请选择一个现有主概念和至少一个可合并概念。");
        }
        await this.appendDecision({ kind: "merge-concepts", canonicalConceptId, mergedConceptIds: merged });
    }

    async undoMerge(decisionId: string): Promise<void> {
        if (!this.state.decisions.some((decision) => decision.kind === "merge-concepts" && decision.id === decisionId)) {
            throw new Error("找不到要撤销的概念合并记录。");
        }
        await this.appendDecision({ kind: "undo-merge", supersedesDecisionId: decisionId });
    }

    async addAlias(conceptId: string, alias: string): Promise<void> {
        this.assertConceptExists(conceptId);
        if (!normalizeConceptName(alias)) throw new Error("Alias 不能为空。");
        await this.appendDecision({ kind: "add-alias", conceptId, alias: alias.trim() });
    }

    async removeAlias(conceptId: string, alias: string): Promise<void> {
        this.assertConceptExists(conceptId);
        if (!normalizeConceptName(alias)) throw new Error("Alias 不能为空。");
        await this.appendDecision({ kind: "remove-alias", conceptId, alias: alias.trim() });
    }

    async createManualRelation(
        type: SemanticRelationType,
        sourceConceptId: string,
        targetConceptId: string,
        evidence?: readonly ConceptEvidenceRef[],
        note?: string,
    ): Promise<void> {
        if (!isSemanticRelationType(type)) throw new Error("不支持的概念关系类型。");
        this.assertConceptExists(sourceConceptId);
        this.assertConceptExists(targetConceptId);
        if (sourceConceptId === targetConceptId) throw new Error("不能把概念关联到自身。");
        if ((!evidence || evidence.length === 0) && !note?.trim()) {
            throw new Error("手工关系必须选择已有 Chunk 证据，或填写用户说明。");
        }
        await this.appendDecision({
            kind: "create-manual-relation",
            relationId: `relation:user:${stableSemanticHash(`${type}\u0000${sourceConceptId}\u0000${targetConceptId}\u0000${this.now()}`)}`,
            type,
            sourceConceptId,
            targetConceptId,
            ...(evidence && evidence.length > 0 ? { evidence: [...evidence] } : {}),
            ...(note?.trim() ? { note: note.trim() } : {}),
        });
    }

    async removeManualRelation(relationId: string): Promise<void> {
        const relation = this.projector.project(this.state).relations.find((item) => item.id === relationId && item.origin === "user");
        if (!relation) throw new Error("找不到可删除的手工关系。");
        await this.appendDecision({ kind: "remove-manual-relation", relationId });
    }

    async undoManualRelationRemoval(decisionId: string): Promise<void> {
        const target = this.state.decisions.find((decision) => decision.id === decisionId);
        if (!target || target.kind !== "remove-manual-relation") {
            throw new Error("找不到可撤销的手工关系删除记录。");
        }
        if (this.state.decisions.some((decision) => decision.kind === "undo-manual-relation-removal" && decision.supersedesDecisionId === decisionId)) {
            throw new Error("该手工关系删除已经撤销。");
        }
        await this.appendDecision({ kind: "undo-manual-relation-removal", supersedesDecisionId: decisionId });
    }

    private async run(
        affectedDocumentPaths: ReadonlySet<string> | undefined,
        providedSignal: AbortSignal | undefined,
        mode: "manual" | "automatic",
    ): Promise<void> {
        const settings = this.dependencies.getSettings();
        if (!settings.enableSemanticGraph) {
            throw new Error("语义概念图谱默认关闭。请先在设置中明确启用它，并确认模型发送范围。");
        }
        const capacity = this.getCapacityAssessment();
        if ((mode === "manual" && !capacity.allowManualSemanticBuild)
            || (mode === "automatic" && !capacity.allowAutomaticSemanticSync)) {
            throw createCapacityError(capacity, mode);
        }
        const signal = this.coordinator.start(providedSignal);
        if (!signal) throw new Error("语义概念图谱任务正在运行。");
        try {
            signal.throwIfAborted();
            const snapshot = this.dependencies.graphService.getSnapshot();
            if (!snapshot) throw new Error("请先重建知识库索引以生成确定性结构图谱。");
            const targetPaths = affectedDocumentPaths ?? new Set([
                ...snapshot.nodes.filter((node) => node.type === "section").map((node) => node.filePath),
                ...this.state.extractions.map((record) => record.documentPath),
            ]);
            const inputs = createSectionExtractionInputs(
                snapshot,
                this.dependencies.documentIndex,
                settings.semanticGraphMaxSectionCharacters,
                targetPaths,
            );
            const model = this.getModelMetadata();
            const result = await this.refreshExtractions(inputs, targetPaths, model, signal);
            this.coordinator.setProgress(result.progress);
            const previousConcepts = this.state.concepts;
            this.state.extractions = result.extractions;
            this.state.concepts = buildConcepts(result.extractions);
            const changedConceptIds = getChangedConceptIds(previousConcepts, this.state.concepts);
            const priorNonModelCandidates = this.state.candidates.filter((candidate) => candidate.origin !== "model");
            this.state.candidates = [
                ...this.buildModelCandidates(result.extractions, this.state.concepts),
                ...priorNonModelCandidates.filter((candidate) => this.state.concepts.some((concept) => concept.id === candidate.sourceConceptId)
                    && this.state.concepts.some((concept) => concept.id === candidate.targetConceptId)),
            ];
            await this.refreshEmbeddings(changedConceptIds, signal);
            await this.refreshSimilarityCandidates(changedConceptIds, model, signal);
            this.refreshRuleCandidates(changedConceptIds, model);
            this.state.updatedAt = this.now();
            this.assertIntegrity(this.state);
            await this.dependencies.store.save(this.state);
            signal.throwIfAborted();
            this.dirty = result.remainingSectionCount > 0 || result.failedSectionCount > 0;
            this.lastError = result.failedSectionCount > 0
                ? `${result.failedSectionCount} 个 Section 未能完成概念抽取，可重试。`
                : null;
        } catch (error: unknown) {
            this.dirty = true;
            this.lastError = describeError(error);
            throw error;
        } finally {
            this.coordinator.finish();
        }
    }

    private async refreshExtractions(
        inputs: readonly SectionExtractionInput[],
        targetPaths: ReadonlySet<string>,
        model: SemanticModelMetadata,
        signal: AbortSignal,
    ): Promise<{
        extractions: SemanticGraphState["extractions"];
        progress: { processedSections: number; queuedSections: number; failedSections: number };
        remainingSectionCount: number;
        failedSectionCount: number;
    }> {
        const signature = `${model.provider}:${model.modelName}:${model.promptVersion}:${model.schemaVersion}`;
        const inputsBySection = groupInputsBySection(inputs);
        const previousTargetBySection = groupRecordsBySection(this.state.extractions.filter((record) => targetPaths.has(record.documentPath)));
        const unchanged = this.state.extractions.filter((record) => !targetPaths.has(record.documentPath));
        const sectionsNeedingWork = Array.from(inputsBySection.entries()).filter(([, sectionInputs]) => {
            const cached = previousTargetBySection.get(sectionInputs[0]?.sectionId ?? "") ?? [];
            return sectionInputs.some((input) => !cached.some((record) => record.inputHash === input.inputHash && record.extractorSignature === signature && !record.lastError));
        });
        const limit = Math.max(1, this.dependencies.getSettings().semanticGraphMaxSectionsPerRun);
        const selectedSections = new Set(sectionsNeedingWork.slice(0, limit).map(([sectionId]) => sectionId));
        const nextTarget: SemanticGraphState["extractions"] = [];
        let processedSections = 0;
        let failedSections = 0;
        for (const [sectionId, sectionInputs] of inputsBySection) {
            const existing = previousTargetBySection.get(sectionId) ?? [];
            const needsWork = sectionsNeedingWork.some(([candidateSectionId]) => candidateSectionId === sectionId);
            if (!needsWork) {
                nextTarget.push(...existing);
                continue;
            }
            if (!selectedSections.has(sectionId)) {
                nextTarget.push(...existing);
                continue;
            }
            try {
                const extracted = [];
                for (const input of sectionInputs) {
                    signal.throwIfAborted();
                    const cached = existing.find((record) => record.inputHash === input.inputHash && record.extractorSignature === signature && !record.lastError);
                    extracted.push(cached ?? await this.dependencies.extractionService.extract(input, model, signal));
                }
                nextTarget.push(...extracted);
                processedSections += 1;
            } catch (error: unknown) {
                failedSections += 1;
                console.warn("[VaultCoach] Section 概念抽取失败，保留上一次有效结果。", sectionId, error);
                nextTarget.push(...existing.map((record) => ({ ...record, lastError: describeError(error) })));
            }
        }
        return {
            extractions: [...unchanged, ...nextTarget].sort((left, right) => left.id.localeCompare(right.id)),
            progress: {
                processedSections,
                queuedSections: Math.max(0, sectionsNeedingWork.length - processedSections),
                failedSections,
            },
            remainingSectionCount: Math.max(0, sectionsNeedingWork.length - selectedSections.size),
            failedSectionCount: failedSections,
        };
    }

    private buildModelCandidates(
        extractions: readonly SemanticGraphState["extractions"][number][],
        concepts: readonly SemanticConcept[],
    ): SemanticCandidate[] {
        const candidateToConceptId = new Map<string, string>();
        for (const record of extractions) {
            for (const candidate of record.candidates) candidateToConceptId.set(candidate.id, createSemanticConceptId(record.sectionId, candidate.normalizedName));
        }
        const knownConceptIds = new Set(concepts.map((concept) => concept.id));
        const candidates = new Map<string, SemanticCandidate>();
        for (const record of extractions) {
            for (const relation of record.relations) {
                const sourceConceptId = candidateToConceptId.get(relation.sourceCandidateId);
                const targetConceptId = candidateToConceptId.get(relation.targetCandidateId);
                if (!sourceConceptId || !targetConceptId || sourceConceptId === targetConceptId
                    || !knownConceptIds.has(sourceConceptId) || !knownConceptIds.has(targetConceptId)) continue;
                const endpoints = isUndirectedRelation(relation.type)
                    ? [sourceConceptId, targetConceptId].sort((left, right) => left.localeCompare(right))
                    : [sourceConceptId, targetConceptId];
                const source = endpoints[0];
                const target = endpoints[1];
                if (!source || !target) continue;
                const fingerprint = createRelationCandidateFingerprint(relation.type, source, target, `model:${record.extractorSignature}`);
                candidates.set(fingerprint, {
                    fingerprint,
                    type: relation.type,
                    sourceConceptId: source,
                    targetConceptId: target,
                    confidence: relation.confidence,
                    origin: "model",
                    evidence: cloneEvidence(relation.evidence),
                    model: record.model ? { ...record.model } : null,
                    sourceSectionId: record.sectionId,
                    createdAt: record.updatedAt,
                    updatedAt: record.updatedAt,
                });
            }
        }
        return Array.from(candidates.values()).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
    }

    private async refreshEmbeddings(changedConceptIds: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
        const modelSignature = this.getEmbeddingSignature();
        const knownConceptIds = new Set(this.state.concepts.map((concept) => concept.id));
        const existing = new Map(this.state.embeddings.map((embedding) => [embedding.conceptId, embedding]));
        const required = this.state.concepts.filter((concept) => changedConceptIds.has(concept.id));
        const missing = required.filter((concept) => {
            const embedding = existing.get(concept.id);
            return !embedding || embedding.modelSignature !== modelSignature || embedding.inputHash !== conceptEmbeddingHash(concept);
        });
        try {
            for (let index = 0; index < missing.length; index += 8) {
                signal.throwIfAborted();
                const batch = missing.slice(index, index + 8);
                const vectors = await this.dependencies.embeddingGateway.embedTexts(
                    batch.map(conceptEmbeddingText),
                    { allowWhenVectorRetrievalDisabled: true },
                );
                for (let vectorIndex = 0; vectorIndex < Math.min(batch.length, vectors.length); vectorIndex += 1) {
                    const concept = batch[vectorIndex];
                    const vector = vectors[vectorIndex];
                    if (!concept || !vector || vector.length === 0) continue;
                    existing.set(concept.id, {
                        conceptId: concept.id,
                        modelSignature,
                        inputHash: conceptEmbeddingHash(concept),
                        vector: [...vector],
                        updatedAt: this.now(),
                    });
                }
            }
        } catch (error: unknown) {
            // Similarity is optional. Rule and model candidates remain usable.
            console.warn("[VaultCoach] Concept embedding 不可用；将仅保留规则和模型关系候选。", error);
            this.lastError = `Concept embedding 不可用：${describeError(error)}`;
        }
        this.state.embeddings = Array.from(existing.values())
            .filter((embedding) => knownConceptIds.has(embedding.conceptId))
            .sort((left, right) => left.conceptId.localeCompare(right.conceptId));
        if (!this.similarityInitialized) {
            await this.similarityIndex.rebuild(this.state.embeddings.map(toConceptEmbeddingRecord));
            this.similarityInitialized = true;
            return;
        }
        const removedIds = Array.from(changedConceptIds).filter((conceptId) => !knownConceptIds.has(conceptId));
        await this.similarityIndex.remove(removedIds);
        await this.similarityIndex.upsert(this.state.embeddings
            .filter((embedding) => changedConceptIds.has(embedding.conceptId))
            .map(toConceptEmbeddingRecord));
    }

    private async refreshSimilarityCandidates(
        changedConceptIds: ReadonlySet<string>,
        model: SemanticModelMetadata,
        signal: AbortSignal,
    ): Promise<void> {
        const existing = this.state.candidates.filter((candidate) => {
            return candidate.origin !== "similarity"
                || (!changedConceptIds.has(candidate.sourceConceptId) && !changedConceptIds.has(candidate.targetConceptId));
        });
        const conceptsById = new Map(this.state.concepts.map((concept) => [concept.id, concept]));
        const embeddingsByConceptId = new Map(this.state.embeddings.map((embedding) => [embedding.conceptId, embedding]));
        const threshold = this.dependencies.getSettings().semanticGraphSimilarityThreshold;
        const topK = Math.max(1, Math.min(50, this.dependencies.getSettings().semanticGraphSimilarityTopK));
        for (const conceptId of Array.from(changedConceptIds).sort()) {
            signal.throwIfAborted();
            const embedding = embeddingsByConceptId.get(conceptId);
            const concept = conceptsById.get(conceptId);
            if (!embedding || !concept) continue;
            const nearest = await this.similarityIndex.findNearest(embedding.vector, topK);
            for (const hit of nearest) {
                const neighbour = conceptsById.get(hit.conceptId);
                if (!neighbour || neighbour.id === concept.id || hit.similarity < threshold) continue;
                const endpoints = [concept.id, neighbour.id].sort((left, right) => left.localeCompare(right));
                const sourceConceptId = endpoints[0];
                const targetConceptId = endpoints[1];
                if (!sourceConceptId || !targetConceptId) continue;
                const fingerprint = createRelationCandidateFingerprint("same_as", sourceConceptId, targetConceptId, `lsh:${embedding.modelSignature}`);
                existing.push({
                    fingerprint,
                    type: "same_as",
                    sourceConceptId,
                    targetConceptId,
                    confidence: hit.similarity,
                    origin: "similarity",
                    evidence: cloneEvidence([...concept.evidence.slice(0, 1), ...neighbour.evidence.slice(0, 1)]),
                    model: { ...model, promptVersion: "concept-similarity/lsh-v1" },
                    createdAt: this.now(),
                    updatedAt: this.now(),
                });
            }
        }
        this.state.candidates = dedupeCandidates(existing);
    }

    private refreshRuleCandidates(changedConceptIds: ReadonlySet<string>, model: SemanticModelMetadata): void {
        const existing = this.state.candidates.filter((candidate) => {
            return candidate.origin !== "rule"
                || (!changedConceptIds.has(candidate.sourceConceptId) && !changedConceptIds.has(candidate.targetConceptId));
        });
        const byNormalizedName = new Map<string, SemanticConcept[]>();
        for (const concept of this.state.concepts) {
            const keys = new Set([concept.normalizedName, ...concept.aliases.map(normalizeConceptName)].filter(Boolean));
            for (const key of keys) {
                const group = byNormalizedName.get(key) ?? [];
                group.push(concept);
                byNormalizedName.set(key, group);
            }
        }
        const maxPerConcept = Math.max(1, Math.min(50, this.dependencies.getSettings().semanticGraphSimilarityTopK));
        for (const source of this.state.concepts.filter((concept) => changedConceptIds.has(concept.id))) {
            const matches = new Map<string, SemanticConcept>();
            for (const key of [source.normalizedName, ...source.aliases.map(normalizeConceptName)]) {
                for (const target of byNormalizedName.get(key) ?? []) if (target.id !== source.id) matches.set(target.id, target);
            }
            for (const target of Array.from(matches.values()).sort((left, right) => left.id.localeCompare(right.id)).slice(0, maxPerConcept)) {
                const endpoints = [source.id, target.id].sort((left, right) => left.localeCompare(right));
                const sourceConceptId = endpoints[0];
                const targetConceptId = endpoints[1];
                if (!sourceConceptId || !targetConceptId) continue;
                const fingerprint = createRelationCandidateFingerprint("same_as", sourceConceptId, targetConceptId, "rule:normalized-name-v1");
                existing.push({
                    fingerprint,
                    type: "same_as",
                    sourceConceptId,
                    targetConceptId,
                    confidence: 1,
                    origin: "rule",
                    evidence: cloneEvidence([...source.evidence.slice(0, 1), ...target.evidence.slice(0, 1)]),
                    model: { ...model, promptVersion: "concept-normalization/v1" },
                    createdAt: this.now(),
                    updatedAt: this.now(),
                });
            }
        }
        this.state.candidates = dedupeCandidates(existing);
    }

    private async appendDecision(decision: UserSemanticDecisionInput): Promise<void> {
        const complete = { ...decision, id: `decision:${stableSemanticHash(`${this.now()}\u0000${JSON.stringify(decision)}\u0000${this.state.decisions.length}`)}`, createdAt: this.now() } as UserSemanticDecision;
        const next: SemanticGraphState = { ...this.state, decisions: [...this.state.decisions, complete], updatedAt: this.now() };
        this.assertIntegrity(next);
        await this.dependencies.store.save(next);
        this.state = next;
        this.dirty = false;
        this.lastError = null;
    }

    private getVisibleConceptIds(
        concepts: readonly SemanticConcept[],
        relations: readonly { sourceConceptId: string; targetConceptId: string }[],
        pendingCandidates: readonly SemanticCandidate[],
        query: ConceptReviewQuery,
        limit: number,
    ): Set<string> {
        const search = query.search?.trim().toLocaleLowerCase() ?? "";
        const selected = query.conceptId;
        const conceptIds = new Set(concepts.map((concept) => concept.id));
        const matches = concepts.filter((concept) => !search || [concept.displayName, ...concept.aliases]
            .some((value) => value.toLocaleLowerCase().includes(search)));
        const matchingIds = new Set(matches.map((concept) => concept.id));
        const ids = new Set<string>();
        const add = (conceptId: string): boolean => {
            if (!conceptIds.has(conceptId) || ids.has(conceptId)) return ids.has(conceptId);
            if (ids.size >= limit) return false;
            ids.add(conceptId);
            return true;
        };
        const addPair = (sourceConceptId: string, targetConceptId: string): void => {
            if (ids.size >= limit || !conceptIds.has(sourceConceptId) || !conceptIds.has(targetConceptId)) return;
            // An edge matters only when both endpoints are visible. Do not use the
            // final free slot for one half of a relationship pair.
            const newEndpoints = Number(!ids.has(sourceConceptId)) + Number(!ids.has(targetConceptId));
            if (newEndpoints > limit - ids.size) return;
            add(sourceConceptId);
            add(targetConceptId);
        };
        const candidateEdges = pendingCandidates.filter((candidate) => !search
            || matchingIds.has(candidate.sourceConceptId)
            || matchingIds.has(candidate.targetConceptId));
        if (selected && conceptIds.has(selected)) {
            add(selected);
            for (const relation of relations) {
                if (relation.sourceConceptId === selected || relation.targetConceptId === selected) {
                    addPair(relation.sourceConceptId, relation.targetConceptId);
                }
            }
            for (const candidate of candidateEdges) {
                if (candidate.sourceConceptId === selected || candidate.targetConceptId === selected) {
                    addPair(candidate.sourceConceptId, candidate.targetConceptId);
                }
            }
        } else {
            // Start a default/search view with complete relation pairs instead of
            // the alphabetically first concepts. This makes solid and dashed
            // links visible even in a large vault while retaining a fixed budget.
            for (const relation of relations) addPair(relation.sourceConceptId, relation.targetConceptId);
            for (const candidate of candidateEdges) addPair(candidate.sourceConceptId, candidate.targetConceptId);
        }
        for (const concept of matches) {
            if (ids.size >= limit) break;
            add(concept.id);
        }
        if (!search && ids.size < limit) {
            for (const concept of concepts) {
                if (ids.size >= limit) break;
                add(concept.id);
            }
        }
        return ids;
    }

    private getStats(): SemanticGraphStats {
        const effective = this.projector.project(this.state);
        const rejected = new Set(effective.rejectedCandidateFingerprints);
        const confirmed = new Set(effective.relations.map((relation) => relation.candidateFingerprint).filter((value): value is string => !!value));
        return {
            extractionCount: this.state.extractions.length,
            conceptCount: effective.concepts.length,
            candidateCount: this.state.candidates.length,
            confirmedRelationCount: effective.relations.length,
            rejectedCandidateCount: rejected.size,
            pendingCandidateCount: this.state.candidates.filter((candidate) => !rejected.has(candidate.fingerprint) && !confirmed.has(candidate.fingerprint)).length,
            embeddingCount: this.state.embeddings.length,
        };
    }

    private getModelMetadata(): SemanticModelMetadata {
        const settings = this.dependencies.getSettings();
        const modelName = settings.modelProvider === "openai-compatible" ? settings.cloudChatModel.trim() : settings.chatModel.trim();
        if (!modelName) throw new Error("未配置用于概念抽取的聊天模型。");
        return {
            provider: settings.modelProvider,
            modelName,
            promptVersion: CONCEPT_EXTRACTION_PROMPT_VERSION,
            schemaVersion: "semantic-graph/v1",
            generatedAt: this.now(),
        };
    }

    private getEmbeddingSignature(): string {
        const settings = this.dependencies.getSettings();
        const provider = settings.embeddingProvider;
        const model = provider === "openai-compatible" ? settings.cloudEmbeddingModel.trim() : settings.embeddingModel.trim();
        return `${provider}:${model}`;
    }

    private assertConceptExists(conceptId: string): void {
        if (!this.state.concepts.some((concept) => concept.id === conceptId)) throw new Error("找不到指定概念。");
    }

    private assertIntegrity(state: SemanticGraphState): void {
        const report = this.integrity.check(state);
        if (!report.valid) throw new Error(`语义图谱完整性校验失败：${report.issues.map((issue) => issue.code).join(", ")}`);
    }

    private now(): number {
        return this.dependencies.getNow?.() ?? Date.now();
    }
}

function groupInputsBySection(inputs: readonly SectionExtractionInput[]): Map<string, SectionExtractionInput[]> {
    const grouped = new Map<string, SectionExtractionInput[]>();
    for (const input of inputs) {
        const group = grouped.get(input.sectionId) ?? [];
        group.push(input);
        grouped.set(input.sectionId, group);
    }
    return grouped;
}

function groupRecordsBySection(records: readonly SemanticGraphState["extractions"][number][]): Map<string, SemanticGraphState["extractions"]> {
    const grouped = new Map<string, SemanticGraphState["extractions"]>();
    for (const record of records) {
        const group = grouped.get(record.sectionId) ?? [];
        group.push(record);
        grouped.set(record.sectionId, group);
    }
    return grouped;
}

function buildConcepts(extractions: readonly SemanticGraphState["extractions"][number][]): SemanticConcept[] {
    const concepts = new Map<string, SemanticConcept>();
    for (const record of extractions) {
        if (record.lastError) continue;
        for (const candidate of record.candidates) {
            const id = createSemanticConceptId(record.sectionId, candidate.normalizedName);
            const existing = concepts.get(id);
            if (!existing) {
                concepts.set(id, {
                    id,
                    displayName: candidate.name,
                    normalizedName: candidate.normalizedName,
                    aliases: normalizeConceptAliases(candidate.aliases, candidate.name),
                    description: candidate.description,
                    evidence: cloneEvidence(candidate.evidence),
                    sourceCandidateIds: [candidate.id],
                    createdAt: record.updatedAt,
                    updatedAt: record.updatedAt,
                });
                continue;
            }
            existing.aliases = normalizeConceptAliases([...existing.aliases, ...candidate.aliases], existing.displayName);
            existing.evidence = dedupeEvidence([...existing.evidence, ...candidate.evidence]);
            existing.sourceCandidateIds = Array.from(new Set([...existing.sourceCandidateIds, candidate.id])).sort();
            existing.updatedAt = Math.max(existing.updatedAt, record.updatedAt);
            if (candidate.description.length > existing.description.length) existing.description = candidate.description;
        }
    }
    return Array.from(concepts.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function getChangedConceptIds(previous: readonly SemanticConcept[], next: readonly SemanticConcept[]): Set<string> {
    const before = new Map(previous.map((concept) => [concept.id, JSON.stringify(concept)]));
    const after = new Map(next.map((concept) => [concept.id, JSON.stringify(concept)]));
    const changed = new Set<string>();
    for (const [id, value] of before) if (after.get(id) !== value) changed.add(id);
    for (const [id, value] of after) if (before.get(id) !== value) changed.add(id);
    return changed;
}

function conceptEmbeddingText(concept: SemanticConcept): string {
    return [concept.displayName, ...concept.aliases, concept.description].filter(Boolean).join("\n");
}

function conceptEmbeddingHash(concept: SemanticConcept): string {
    return stableSemanticHash(conceptEmbeddingText(concept));
}

function toConceptEmbeddingRecord(embedding: SemanticEmbeddingRecord): ConceptEmbeddingRecord {
    return { conceptId: embedding.conceptId, vector: [...embedding.vector] };
}

function dedupeCandidates(candidates: readonly SemanticCandidate[]): SemanticCandidate[] {
    const byFingerprint = new Map<string, SemanticCandidate>();
    for (const candidate of candidates) {
        const current = byFingerprint.get(candidate.fingerprint);
        if (!current || candidate.confidence > current.confidence || candidate.updatedAt > current.updatedAt) {
            byFingerprint.set(candidate.fingerprint, candidate);
        }
    }
    return Array.from(byFingerprint.values()).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

/** Deterministic order also defines which bounded local candidate edges are shown first. */
function compareCandidatePriority(left: SemanticCandidate, right: SemanticCandidate): number {
    return right.confidence - left.confidence
        || left.origin.localeCompare(right.origin)
        || left.fingerprint.localeCompare(right.fingerprint);
}

function cloneEvidence(evidence: readonly ConceptEvidenceRef[]): ConceptEvidenceRef[] {
    return evidence.map((item) => ({ ...item, locator: { ...item.locator } }));
}

function dedupeEvidence(evidence: readonly ConceptEvidenceRef[]): ConceptEvidenceRef[] {
    const byId = new Map(evidence.map((item) => [`${item.sectionId}:${item.chunkId}:${item.excerptId}`, item]));
    return Array.from(byId.values()).sort((left, right) => String(left.chunkId).localeCompare(String(right.chunkId)));
}

function cloneConcept(concept: SemanticConcept): SemanticConcept {
    return { ...concept, aliases: [...concept.aliases], evidence: cloneEvidence(concept.evidence), sourceCandidateIds: [...concept.sourceCandidateIds] };
}

function cloneCandidate(candidate: SemanticCandidate): SemanticCandidate {
    return { ...candidate, evidence: cloneEvidence(candidate.evidence), model: candidate.model ? { ...candidate.model } : null };
}

function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function isSemanticRelationType(value: string): value is SemanticRelationType {
    return value === "same_as" || value === "part_of" || value === "prerequisite_of" || value === "used_for" || value === "contrasts_with" || value === "related_to";
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createCapacityError(capacity: GraphCapacityAssessment, mode: "manual" | "automatic"): Error {
    const action = mode === "automatic" ? "自动语义同步" : "本地语义图重建";
    const reason = capacity.reasons[0];
    const detail = reason
        ? `${reason.metric}=${reason.actual}，超过 ${reason.level} 阈值 ${reason.threshold}`
        : "当前知识库规模超过本地处理预算";
    return new Error(`${action}已停止：${detail}。现有图谱和问答/考试不受影响；请缩小知识范围，或在后续独立图谱服务可用时使用该服务。`);
}
