import type { ChatService } from "./chat/chat-service";
import type { ChatApplicationApi, ExamApplicationApi, GraphApplicationApi, IndexApplicationApi, KnowledgeEngineApplicationApi, KnowledgeIndexViewState, LearningGraphApplicationApi, MasteryApplicationApi, ProgressApplicationApi, RecommendationApplicationApi, SemanticGraphApplicationApi, VaultCoachApplicationApi } from "./application-api";
import type { ApplicationEvent, ApplicationEventListener } from "./application-events";
import type { AssessmentEventFactory } from "../domain/assessment/assessment-event-factory";
import { getQuestionIdsNeedingAssessmentEvents } from "../domain/assessment/assessment-event-fingerprint";
import {
    ASSESSMENT_SESSION_SCHEMA_VERSION,
    type AssessmentExamHistoryItem,
    type AssessmentConceptBinding,
    type AssessmentEvent,
    type AssessmentSessionDocumentV1,
    type AssessmentSessionStore,
} from "../domain/assessment/assessment-types";
import type { ExamEngine } from "../exam/exam-engine";
import type { ExamEvaluator } from "../domain/exam/exam-evaluation-router";
import type { ExamSessionStore, MarkdownExamHistoryRecord } from "../exam/exam-session-store";
import type { ExamEvaluationMetadata, ExamGenerationOptions, ExamHistoryItem, ExamScopeSelection, ExamSession } from "../domain/exam/exam-types";
import type { KnowledgeGraphService } from "./graph/knowledge-graph-service";
import type { SemanticGraphService } from "./semantic-graph/semantic-graph-service";
import type { ConceptEvidenceRef, SemanticRelationType } from "../domain/semantic-graph/semantic-graph-types";
import type { LearningGraphQuery } from "../domain/learning-graph/learning-graph-types";
import type { LearningGraphQueryService } from "./learning-graph/learning-graph-query-service";
import type { MasteryService } from "./mastery/mastery-service";
import type { ProgressService } from "./progress/progress-service";
import type { AdaptiveExamPlanner } from "./exam/adaptive-exam-planner";
import type { RecommendationService } from "./recommendation/recommendation-service";
import type { AdaptiveExamPlanRequest, AdaptiveExamPlanResult } from "../domain/adaptive-exam/adaptive-exam-types";
import {
    PROGRESS_SNAPSHOT_SCHEMA_VERSION,
    type ProgressSnapshot,
    type ProgressStateView,
} from "./progress/progress-types";
import type { RecommendationSnapshot, ReviewAction } from "../domain/recommendation/recommendation-types";
import type { KnowledgeEngineClient } from "./engine/knowledge-engine-types";

export interface VaultCoachApplicationDependencies {
    chatService: ChatService;
    examEngine: ExamEngine;
    examEvaluationService: ExamEvaluator;
    examSessionStore: ExamSessionStore;
    assessmentSessionStore: AssessmentSessionStore;
    assessmentEventFactory: AssessmentEventFactory;
    getAssessmentSavedAt(): number;
    getAssessmentSessionPath(sessionId: string): string;
    getAssessmentSessionIdFromPath(path: string): string | null;
    getScopeOptions(): ReturnType<ExamEngine["getScopeOptions"]>;
    normalizeFolderPaths(folderPaths: string[]): string[];
    normalizeSelection(selection: ExamScopeSelection): ExamScopeSelection;
    ensureKnowledgeBaseReady(): Promise<void>;
    getFullScopeLabel(): string;
    getNoEligibleChunksMessage(): string;
    getExamEvaluationMetadata(): ExamEvaluationMetadata;
    getIndexState(): KnowledgeIndexViewState;
    rebuildIndex(signal?: AbortSignal): Promise<void>;
    clearIndex(): Promise<void>;
    abortIndex(): void;
    getStorageFootprint(): Promise<import("../domain/index-lifecycle/storage-footprint").StorageFootprint>;
    knowledgeGraphService: KnowledgeGraphService;
    semanticGraphService: SemanticGraphService;
    learningGraphQueryService?: LearningGraphQueryService;
    masteryService?: MasteryService;
    progressService?: ProgressService;
    adaptiveExamPlanner?: AdaptiveExamPlanner;
    recommendationService?: RecommendationService;
    knowledgeEngineClient?: KnowledgeEngineClient;
}

/** Application facade with grouped use-case APIs and no Obsidian UI dependency. */
export class VaultCoachApplication implements VaultCoachApplicationApi {
    readonly chat: ChatApplicationApi;
    readonly exam: ExamApplicationApi;
    readonly index: IndexApplicationApi;
    readonly graph: GraphApplicationApi;
    readonly semanticGraph: SemanticGraphApplicationApi;
    readonly learningGraph: LearningGraphApplicationApi;
    readonly mastery: MasteryApplicationApi;
    readonly progress: ProgressApplicationApi;
    readonly recommendations: RecommendationApplicationApi;
    readonly engine: KnowledgeEngineApplicationApi;
    private readonly listeners: Set<ApplicationEventListener> = new Set();

    constructor(private readonly dependencies: VaultCoachApplicationDependencies) {
        this.chat = {
            getMessages: () => dependencies.chatService.getMessages(),
            appendUserMessage: async (text) => {
                await dependencies.chatService.appendUserMessage(text);
                this.emit({ type: "conversation-changed" });
            },
            streamAssistantTurn: async (text, handlers) => {
                const answer = await dependencies.chatService.streamAssistantTurn(text, handlers);
                this.emit({ type: "conversation-changed" });
                return answer;
            },
            resetConversation: () => {
                dependencies.chatService.resetConversation();
                this.emit({ type: "conversation-changed" });
            },
        };
        this.exam = this.createExamApi();
        this.index = {
            rebuild: async (signal) => {
                await dependencies.rebuildIndex(signal);
                this.emit({ type: "index-state-changed" });
            },
            clear: async () => {
                await dependencies.clearIndex();
                this.emit({ type: "index-state-changed" });
            },
            abort: () => {
                dependencies.abortIndex();
                this.emit({ type: "index-state-changed" });
            },
            getState: () => dependencies.getIndexState(),
            getStorageFootprint: () => dependencies.getStorageFootprint(),
        };
        this.graph = this.createGraphApi();
        this.semanticGraph = this.createSemanticGraphApi();
        this.learningGraph = this.createLearningGraphApi();
        this.mastery = this.createMasteryApi();
        this.progress = this.createProgressApi();
        this.recommendations = this.createRecommendationApi();
        this.engine = this.createKnowledgeEngineApi();
    }

    subscribe(listener: ApplicationEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async dispose(): Promise<void> {
        this.listeners.clear();
    }

    /** Allows non-UI coordinators to publish an index state change. */
    notifyIndexStateChanged(): void {
        this.invalidateProgress();
        this.emit({ type: "index-state-changed" });
    }

    /** Publishes checkpoint progress from the semantic service to open views. */
    notifySemanticGraphStateChanged(): void {
        this.emit({ type: "semantic-graph-state-changed" });
    }

    private createExamApi(): ExamApplicationApi {
        const dependencies = this.dependencies;
        return {
            getScopeOptions: () => dependencies.getScopeOptions(),
            getFileOptions: (folders) => dependencies.examEngine.getFileOptions(
                dependencies.normalizeFolderPaths(folders),
            ),
            getScopeSnapshot: (selection) => dependencies.examEngine.getScopeSnapshot(dependencies.normalizeSelection(selection)),
            analyzeScope: async (selection, options: ExamGenerationOptions = {}) => {
                await dependencies.ensureKnowledgeBaseReady();
                return dependencies.examEngine.analyzeScope(dependencies.normalizeSelection(selection), options);
            },
            previewAdaptivePlan: async (request: AdaptiveExamPlanRequest): Promise<AdaptiveExamPlanResult> => {
                const planner = dependencies.adaptiveExamPlanner;
                if (!planner) {
                    return {
                        status: "unavailable",
                        reasonCode: "no-effective-concepts",
                        message: "自适应考试规划暂不可用；仍可按所选范围生成普通考试。",
                    };
                }
                await dependencies.ensureKnowledgeBaseReady();
                return planner.preview({ ...request, selection: dependencies.normalizeSelection(request.selection) });
            },
            createSession: async (selection, count, options: ExamGenerationOptions = {}) => {
                await dependencies.ensureKnowledgeBaseReady();
                const normalized = dependencies.normalizeSelection(selection);
                const snapshot = dependencies.examEngine.getScopeSnapshot(normalized);
                if (!dependencies.examEngine.hasEligibleChunks(normalized)) {
                    throw new Error(dependencies.getNoEligibleChunksMessage());
                }
                const label = normalized.selectedFolderPaths.length === 0 ? dependencies.getFullScopeLabel() : normalized.selectedFolderPaths.join(", ");
                const effectiveCount = snapshot.estimatedMaxQuestions > 0
                    ? Math.min(count, snapshot.estimatedMaxQuestions)
                    : count;
                if (options.adaptivePlan) {
                    const planner = dependencies.adaptiveExamPlanner;
                    const analysis = options.analysis;
                    if (!planner || !analysis) {
                        throw new Error("自适应考试计划不可用，请返回并重新分析。");
                    }
                    const plannedQuestionCount = options.adaptivePlan.targets
                        .reduce((total, target) => total + target.expectedQuestionCount, 0);
                    const current = plannedQuestionCount === effectiveCount && await planner.isCurrent(options.adaptivePlan, {
                        selection: normalized,
                        analysis,
                        questionCount: effectiveCount,
                        examMode: options.examMode ?? options.adaptivePlan.examMode,
                        targetMode: options.adaptivePlan.targetMode,
                    });
                    if (!current) {
                        throw new Error("知识状态已变化，请返回并重新分析后生成考试。");
                    }
                }
                return dependencies.examEngine.createExamSession(
                    label,
                    normalized,
                    effectiveCount,
                    snapshot,
                    options,
                );
            },
            submitSession: async (session, answers) => ({
                ...session,
                userAnswers: session.questions.map((_question, index) => answers[index]?.trim() ?? ""),
                evaluation: await dependencies.examEvaluationService.evaluate(
                    session,
                    answers,
                    dependencies.getExamEvaluationMetadata(),
                ),
                status: "submitted",
            }),
            saveSession: async (session) => this.saveExamSession(session),
            exportSession: (session, folderPath) => dependencies.examSessionStore.export(session, folderPath),
            listHistory: () => this.listExamHistory(),
            readHistory: (path) => this.readExamHistoryContent(path),
            deleteSession: async (session) => {
                await dependencies.examSessionStore.deleteSession(session);
                this.emit({ type: "exam-history-changed" });
            },
            deleteHistory: async (path) => {
                await this.deleteExamHistory(path);
                this.emit({ type: "exam-history-changed" });
            },
        };
    }

    private createGraphApi(): GraphApplicationApi {
        const graphService = this.dependencies.knowledgeGraphService;
        return {
            rebuild: async (signal) => {
                const snapshot = await graphService.rebuildAll(signal);
                this.dependencies.learningGraphQueryService?.invalidate();
                this.dependencies.masteryService?.markDirty("知识图谱已变更，需要重新计算掌握度。");
                this.invalidateProgress();
                this.emit({ type: "graph-state-changed" });
                this.emit({ type: "mastery-state-changed" });
                return snapshot;
            },
            getSnapshot: async () => graphService.getSnapshot(),
            getNode: async (nodeId) => graphService.getNode(nodeId),
            findNodesByDocumentPath: async (filePath) => graphService.findNodesByDocumentPath(filePath),
            findEdgesForNode: async (nodeId) => graphService.findEdgesForNode(nodeId),
            findEdgesBySourceFile: async (filePath) => graphService.findEdgesBySourceFile(filePath),
            getEdgeSources: async (edgeId) => graphService.getEdgeSources(edgeId),
            checkIntegrity: async () => graphService.checkIntegrity(),
        };
    }

    private createSemanticGraphApi(): SemanticGraphApplicationApi {
        const service = this.dependencies.semanticGraphService;
        const invalidate = () => {
            this.dependencies.learningGraphQueryService?.invalidate();
            this.dependencies.masteryService?.markDirty("有效概念图谱已变更，需要重新计算掌握度。");
            this.invalidateProgress();
        };
        return {
            rebuild: async (signal) => {
                const rebuilding = service.rebuildAll(signal);
                // SemanticIndexCoordinator enters busy state synchronously before
                // its first await. Publish it now so every open workspace can
                // show a single, non-clickable build-in-progress state.
                this.emit({ type: "semantic-graph-state-changed" });
                try {
                    await rebuilding;
                    invalidate();
                    this.emit({ type: "mastery-state-changed" });
                } finally {
                    this.emit({ type: "semantic-graph-state-changed" });
                }
            },
            clear: async () => { await service.clear(); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            resetGovernanceDecisions: async () => {
                await service.resetGovernanceDecisions();
                invalidate();
                this.emit({ type: "semantic-graph-state-changed" });
                this.emit({ type: "mastery-state-changed" });
            },
            getGovernanceImpact: () => service.getGovernanceImpact(),
            abort: () => { service.abort(); this.emit({ type: "semantic-graph-state-changed" }); },
            getState: () => service.getState(),
            getReviewProjection: async (query) => service.getReviewProjection(query),
            confirmCandidate: async (fingerprint) => { await service.confirmCandidate(fingerprint); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            rejectCandidate: async (fingerprint, reason) => { await service.rejectCandidate(fingerprint, reason); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            undoCandidateDecision: async (decisionId) => { await service.undoCandidateDecision(decisionId); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            mergeConcepts: async (canonicalConceptId, mergedConceptIds) => { await service.mergeConcepts(canonicalConceptId, mergedConceptIds); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            undoMerge: async (decisionId) => { await service.undoMerge(decisionId); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            addAlias: async (conceptId, alias) => { await service.addAlias(conceptId, alias); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            removeAlias: async (conceptId, alias) => { await service.removeAlias(conceptId, alias); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            createManualRelation: async (type: SemanticRelationType, sourceConceptId: string, targetConceptId: string, evidence?: readonly ConceptEvidenceRef[], note?: string) => {
                await service.createManualRelation(type, sourceConceptId, targetConceptId, evidence, note); invalidate();
                this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" });
            },
            removeManualRelation: async (relationId) => { await service.removeManualRelation(relationId); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
            undoManualRelationRemoval: async (decisionId) => { await service.undoManualRelationRemoval(decisionId); invalidate(); this.emit({ type: "semantic-graph-state-changed" }); this.emit({ type: "mastery-state-changed" }); },
        };
    }

    private createLearningGraphApi(): LearningGraphApplicationApi {
        return {
            getProjection: async (query: LearningGraphQuery = {}) => {
                const service = this.dependencies.learningGraphQueryService;
                if (!service) throw new Error("Learning graph service is unavailable.");
                return service.getProjection(query);
            },
            getConceptCatalog: async () => {
                const service = this.dependencies.learningGraphQueryService;
                if (!service) throw new Error("Learning graph service is unavailable.");
                return service.getConceptCatalog();
            },
        };
    }

    private createMasteryApi(): MasteryApplicationApi {
        const service = this.dependencies.masteryService;
        return {
            getState: () => service?.getState() ?? unavailableMasteryState(),
            getSnapshot: () => service?.getSnapshot() ?? null,
            getConceptState: (conceptId) => service?.getConceptState(conceptId) ?? null,
            rebuild: async () => {
                if (!service) throw new Error("Mastery service is unavailable.");
                const snapshot = await service.rebuildAll();
                this.invalidateProgress();
                this.emit({ type: "mastery-state-changed" });
                return snapshot;
            },
            clear: async () => {
                if (!service) throw new Error("Mastery service is unavailable.");
                await service.clear();
                this.invalidateProgress();
                this.emit({ type: "mastery-state-changed" });
            },
        };
    }

    private createProgressApi(): ProgressApplicationApi {
        const service = this.dependencies.progressService;
        return {
            isAvailable: () => service !== undefined,
            getState: (): ProgressStateView => service?.getState() ?? unavailableProgressState(),
            getSnapshot: async (): Promise<ProgressSnapshot> => {
                if (!service) {
                    return createUnavailableProgressSnapshot();
                }
                return service.getSnapshot();
            },
        };
    }

    private createRecommendationApi(): RecommendationApplicationApi {
        const service = this.dependencies.recommendationService;
        return {
            isAvailable: () => service !== undefined,
            getSnapshot: async (): Promise<RecommendationSnapshot> => {
                if (!service) return createUnavailableRecommendationSnapshot();
                return service.getSnapshot();
            },
            recordAction: async (recommendationId: string, action: ReviewAction, deferUntil?: number): Promise<void> => {
                if (!service) throw new Error("Recommendation service is unavailable.");
                await service.recordAction(recommendationId, action, deferUntil);
                this.dependencies.progressService?.invalidate();
                this.emit({ type: "recommendations-changed" });
            },
            exportMarkdown: async (): Promise<string> => {
                if (!service) return "# VaultCoach study plan\n\nStudy recommendations are unavailable.\n";
                return createRecommendationsMarkdown(await service.getSnapshot());
            },
        };
    }

    private createKnowledgeEngineApi(): KnowledgeEngineApplicationApi {
        const client = this.dependencies.knowledgeEngineClient;
        return {
            getAvailability: () => client ? cloneEngineAvailability(client.getAvailability()) : unavailableEngineAvailability(),
            getDiagnostics: () => client ? { ...client.getDiagnostics() } : unavailableEngineDiagnostics(),
            refresh: async (signal?: AbortSignal) => {
                if (!client) return unavailableEngineAvailability();
                return cloneEngineAvailability(await client.refresh(signal));
            },
        };
    }

    /**
     * Persists structured facts before their disposable Markdown projection.
     * Draft saving retains the legacy report-only behaviour for compatibility.
     */
    private async saveExamSession(session: ExamSession): Promise<ExamSession> {
        const dependencies = this.dependencies;
        if (session.adaptivePlan && session.adaptivePlan.examMode !== session.examMode) {
            throw new Error("考试模式与自适应考试计划不一致，无法保存。");
        }
        if (!session.evaluation) {
            const saved = await dependencies.examSessionStore.save(session);
            this.emit({ type: "exam-history-changed" });
            return saved;
        }

        const existingDocument = await dependencies.assessmentSessionStore.read(session.id);
        const sessionWithExistingReportPath: ExamSession = existingDocument
            && !session.savedPath
            && existingDocument.examSession.savedPath
            ? { ...session, savedPath: existingDocument.examSession.savedPath }
            : session;
        const savedSession = dependencies.examSessionStore.prepareSessionForSave(sessionWithExistingReportPath);
        const previousEvents: readonly AssessmentEvent[] = existingDocument?.assessmentEvents ?? [];
        const questionIdsNeedingEvents = getQuestionIdsNeedingAssessmentEvents(savedSession, previousEvents);
        const createdEvidence = dependencies.assessmentEventFactory.createForQuestionIds(
            savedSession,
            questionIdsNeedingEvents,
            previousEvents,
        );
        const document: AssessmentSessionDocumentV1 = existingDocument && createdEvidence.events.length === 0
            ? existingDocument
            : {
                schemaVersion: ASSESSMENT_SESSION_SCHEMA_VERSION,
                sessionId: savedSession.id,
                savedAt: dependencies.getAssessmentSavedAt(),
                examSession: savedSession,
                assessmentEvents: [...previousEvents, ...createdEvidence.events],
                conceptBindings: mergeConceptBindings(
                    existingDocument?.conceptBindings ?? [],
                    createdEvidence.conceptBindings,
                ),
            };

        if (document !== existingDocument) {
            await dependencies.assessmentSessionStore.save(document);
            this.invalidateProgress();
        }

        const projectedSession = await dependencies.examSessionStore.writeAssessmentProjection(
            document,
            dependencies.getAssessmentSessionPath(document.sessionId),
        );
        if (dependencies.masteryService) {
            try {
                await dependencies.masteryService.syncForSession(document);
            } catch (error: unknown) {
                // This cache is derived from already-persisted Assessment facts.
                // It must never turn a successful exam save into a failed one.
                console.error("[VaultCoachApplication] 掌握度增量计算失败，Assessment 证据已保留。", error);
                dependencies.masteryService.markDirty("掌握度增量计算失败，需要稍后重新计算。");
            }
            this.emit({ type: "mastery-state-changed" });
        }
        this.emit({ type: "exam-history-changed" });
        return projectedSession;
    }

    private async listExamHistory(): Promise<ExamHistoryItem[]> {
        const [assessmentItems, markdownRecords] = await Promise.all([
            this.dependencies.assessmentSessionStore.listHistory(),
            this.dependencies.examSessionStore.listMarkdownHistoryRecords(),
        ]);
        return mergeExamHistory(assessmentItems, markdownRecords);
    }

    private async readExamHistoryContent(path: string): Promise<string> {
        const sessionId = this.dependencies.getAssessmentSessionIdFromPath(path);
        if (!sessionId) {
            return this.dependencies.examSessionStore.readHistoryContent(path);
        }

        const document = await this.dependencies.assessmentSessionStore.read(sessionId);
        if (!document) {
            throw new Error(`找不到 Assessment Session：${sessionId}`);
        }

        return this.dependencies.examSessionStore.readOrCreateAssessmentProjection(
            document,
            this.dependencies.getAssessmentSessionPath(sessionId),
        );
    }

    private async deleteExamHistory(path: string): Promise<void> {
        const sessionId = this.dependencies.getAssessmentSessionIdFromPath(path);
        if (!sessionId) {
            await this.dependencies.examSessionStore.deleteHistory(path);
            return;
        }

        const document = await this.dependencies.assessmentSessionStore.read(sessionId);
        if (!document) {
            throw new Error(`找不到 Assessment Session：${sessionId}`);
        }

        await this.dependencies.examSessionStore.deleteSession(document.examSession);
    }

    private emit(event: ApplicationEvent): void {
        if (event.type === "mastery-state-changed" && !this.dependencies.masteryService) return;
        this.listeners.forEach((listener) => listener(event));
    }

    private invalidateProgress(): void {
        this.dependencies.progressService?.invalidate();
        this.dependencies.recommendationService?.invalidate();
    }
}

function unavailableMasteryState() {
    return {
        hasSnapshot: false,
        dirty: true,
        busy: false,
        lastError: "Mastery service is unavailable.",
        algorithmVersion: null,
        stateCount: 0,
        sourceEventCount: 0,
        unboundIssueCount: 0,
    } as const;
}

function createUnavailableProgressSnapshot(): ProgressSnapshot {
    return {
        schemaVersion: PROGRESS_SNAPSHOT_SCHEMA_VERSION,
        generatedAt: Date.now(),
        graph: {
            status: "unavailable",
            conceptCount: 0,
            message: "Progress service is unavailable.",
        },
        mastery: {
            status: "unavailable",
            message: "Progress service is unavailable.",
            conceptCount: 0,
            assessedConceptCount: 0,
            coverageRatio: null,
            levelCounts: {
                unknown: 0,
                weak: 0,
                developing: 0,
                proficient: 0,
                mastered: 0,
            },
            snapshotCalculatedAt: null,
            algorithmVersion: null,
            sourceEventCount: 0,
            unboundIssueCount: 0,
        },
        assessments: {
            status: "unavailable",
            message: "Progress service is unavailable.",
            sessionCount: 0,
            scoredSessionCount: 0,
            latestSessionAt: null,
        },
        recommendations: [],
    };
}

function createUnavailableRecommendationSnapshot(): RecommendationSnapshot {
    return {
        algorithmVersion: "recommendation/unavailable",
        generatedAt: Date.now(),
        primary: [],
        queue: [],
    };
}

/** Markdown is an export projection only; recommendation facts stay in JSON. */
function createRecommendationsMarkdown(snapshot: RecommendationSnapshot): string {
    const open = snapshot.primary;
    const lines = [
        "# VaultCoach study plan",
        "",
        `Generated: ${new Date(snapshot.generatedAt).toISOString()}`,
        `Algorithm: ${snapshot.algorithmVersion}`,
        "",
    ];
    if (open.length === 0) {
        lines.push("No open recommendations are available.");
        return `${lines.join("\n")}\n`;
    }
    lines.push("## Next steps", "");
    for (const item of open) {
        lines.push(`- [ ] **${escapeMarkdown(item.label)}** — ${item.reasonCodes.join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}<>]/g, "\\$&");
}

function unavailableProgressState(): ProgressStateView {
    return {
        hasSnapshot: false,
        dirty: true,
        busy: false,
        lastError: "Progress service is unavailable.",
        generatedAt: null,
    };
}

function unavailableEngineAvailability(): import("./engine/knowledge-engine-types").KnowledgeEngineAvailability {
    return {
        mode: "lite",
        status: "unavailable",
        protocolVersion: 1,
        capabilities: [],
        reason: "not-configured",
        detail: "Knowledge Engine client is unavailable; Vault Coach Lite remains available.",
    };
}

function unavailableEngineDiagnostics(): import("./engine/knowledge-engine-types").KnowledgeEngineDiagnostics {
    return {
        endpoint: null,
        lastCheckedAt: null,
        lastError: "Knowledge Engine client is unavailable.",
        networkRequestsMade: 0,
        dataTransfer: "none",
    };
}

function cloneEngineAvailability(
    availability: import("./engine/knowledge-engine-types").KnowledgeEngineAvailability,
): import("./engine/knowledge-engine-types").KnowledgeEngineAvailability {
    return { ...availability, capabilities: [...availability.capabilities] };
}

function mergeConceptBindings(
    existingBindings: readonly AssessmentConceptBinding[],
    createdBindings: readonly AssessmentConceptBinding[],
): AssessmentConceptBinding[] {
    const bindingsById = new Map<string, AssessmentConceptBinding>();
    for (const binding of [...existingBindings, ...createdBindings]) {
        bindingsById.set(binding.id, binding);
    }

    return Array.from(bindingsById.values());
}

function mergeExamHistory(
    assessmentItems: readonly AssessmentExamHistoryItem[],
    markdownRecords: readonly MarkdownExamHistoryRecord[],
): ExamHistoryItem[] {
    const knownSessionIds = new Set<string>();
    const items: ExamHistoryItem[] = assessmentItems.map((item: AssessmentExamHistoryItem) => {
        knownSessionIds.add(item.sessionId);
        return item;
    });

    for (const record of markdownRecords) {
        if (record.sessionId && knownSessionIds.has(record.sessionId)) {
            continue;
        }
        if (record.sessionId) {
            knownSessionIds.add(record.sessionId);
        }
        items.push(record.item);
    }

    return items.sort((left: ExamHistoryItem, right: ExamHistoryItem) => {
        return (right.createdAt ?? right.modifiedAt ?? 0) - (left.createdAt ?? left.modifiedAt ?? 0);
    });
}
