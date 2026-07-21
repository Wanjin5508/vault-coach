import type { ChatService } from "./chat/chat-service";
import type { ChatApplicationApi, ExamApplicationApi, GraphApplicationApi, IndexApplicationApi, KnowledgeIndexViewState, ProgressApplicationApi, SemanticGraphApplicationApi, VaultCoachApplicationApi } from "./application-api";
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
import type { ExamEvaluationService } from "../domain/exam/exam-evaluation-service";
import type { ExamSessionStore, MarkdownExamHistoryRecord } from "../exam/exam-session-store";
import type { ExamEvaluationMetadata, ExamGenerationOptions, ExamHistoryItem, ExamScopeSelection, ExamSession } from "../domain/exam/exam-types";
import type { KnowledgeGraphService } from "./graph/knowledge-graph-service";
import type { SemanticGraphService } from "./semantic-graph/semantic-graph-service";
import type { ConceptEvidenceRef, SemanticRelationType } from "../domain/semantic-graph/semantic-graph-types";

export interface VaultCoachApplicationDependencies {
    chatService: ChatService;
    examEngine: ExamEngine;
    examEvaluationService: ExamEvaluationService;
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
    knowledgeGraphService: KnowledgeGraphService;
    semanticGraphService: SemanticGraphService;
}

/** Application facade with grouped use-case APIs and no Obsidian UI dependency. */
export class VaultCoachApplication implements VaultCoachApplicationApi {
    readonly chat: ChatApplicationApi;
    readonly exam: ExamApplicationApi;
    readonly index: IndexApplicationApi;
    readonly graph: GraphApplicationApi;
    readonly semanticGraph: SemanticGraphApplicationApi;
    readonly progress: ProgressApplicationApi = { isAvailable: () => false };
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
        };
        this.graph = this.createGraphApi();
        this.semanticGraph = this.createSemanticGraphApi();
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
        this.emit({ type: "index-state-changed" });
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
                this.emit({ type: "graph-state-changed" });
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
        return {
            rebuild: async (signal) => { await service.rebuildAll(signal); this.emit({ type: "semantic-graph-state-changed" }); },
            clear: async () => { await service.clear(); this.emit({ type: "semantic-graph-state-changed" }); },
            abort: () => { service.abort(); this.emit({ type: "semantic-graph-state-changed" }); },
            getState: () => service.getState(),
            getReviewProjection: async (query) => service.getReviewProjection(query),
            confirmCandidate: async (fingerprint) => { await service.confirmCandidate(fingerprint); this.emit({ type: "semantic-graph-state-changed" }); },
            rejectCandidate: async (fingerprint, reason) => { await service.rejectCandidate(fingerprint, reason); this.emit({ type: "semantic-graph-state-changed" }); },
            undoCandidateDecision: async (decisionId) => { await service.undoCandidateDecision(decisionId); this.emit({ type: "semantic-graph-state-changed" }); },
            mergeConcepts: async (canonicalConceptId, mergedConceptIds) => { await service.mergeConcepts(canonicalConceptId, mergedConceptIds); this.emit({ type: "semantic-graph-state-changed" }); },
            undoMerge: async (decisionId) => { await service.undoMerge(decisionId); this.emit({ type: "semantic-graph-state-changed" }); },
            addAlias: async (conceptId, alias) => { await service.addAlias(conceptId, alias); this.emit({ type: "semantic-graph-state-changed" }); },
            removeAlias: async (conceptId, alias) => { await service.removeAlias(conceptId, alias); this.emit({ type: "semantic-graph-state-changed" }); },
            createManualRelation: async (type: SemanticRelationType, sourceConceptId: string, targetConceptId: string, evidence?: readonly ConceptEvidenceRef[], note?: string) => {
                await service.createManualRelation(type, sourceConceptId, targetConceptId, evidence, note);
                this.emit({ type: "semantic-graph-state-changed" });
            },
            removeManualRelation: async (relationId) => { await service.removeManualRelation(relationId); this.emit({ type: "semantic-graph-state-changed" }); },
            undoManualRelationRemoval: async (decisionId) => { await service.undoManualRelationRemoval(decisionId); this.emit({ type: "semantic-graph-state-changed" }); },
        };
    }

    /**
     * Persists structured facts before their disposable Markdown projection.
     * Draft saving retains the legacy report-only behaviour for compatibility.
     */
    private async saveExamSession(session: ExamSession): Promise<ExamSession> {
        const dependencies = this.dependencies;
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
        }

        const projectedSession = await dependencies.examSessionStore.writeAssessmentProjection(
            document,
            dependencies.getAssessmentSessionPath(document.sessionId),
        );
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
        this.listeners.forEach((listener) => listener(event));
    }
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
