import type { App } from "obsidian";
import { AssessmentEventFactory } from "../domain/assessment/assessment-event-factory";
import { DeterministicGraphBuilder } from "../domain/graph/deterministic-graph-builder";
import { ExamEngine } from "../exam/exam-engine";
import { ExamSessionStore } from "../exam/exam-session-store";
import { EXAM_EVALUATION_PROMPT_VERSION, ExamEvaluationService } from "../domain/exam/exam-evaluation-service";
import { ExamEvaluationRouter, type ExamEvaluator } from "../domain/exam/exam-evaluation-router";
import { ObjectiveExamEvaluationService } from "../domain/exam/objective-exam-evaluation-service";
import {
    getAssessmentSessionIdFromPath,
    getAssessmentSessionPath,
    JsonAssessmentSessionStore,
} from "../infrastructure/storage/json-assessment-session-store";
import { VaultKnowledgeBase } from "../knowledge-base";
import { LocalModelClient } from "../model-client";
import { ObsidianDocumentFileMetadataReader } from "../infrastructure/obsidian/obsidian-document-file-metadata-reader";
import { ObsidianGraphSourceReader } from "../infrastructure/obsidian/obsidian-graph-source-reader";
import { JsonGraphStore } from "../infrastructure/storage/json-graph-store";
import { JsonSemanticGraphStore } from "../infrastructure/storage/json-semantic-graph-store";
import { JsonMasteryStore } from "../infrastructure/storage/json-mastery-store";
import { JsonReviewActionStore } from "../infrastructure/storage/json-review-action-store";
import { StorageFootprintReporter } from "../infrastructure/storage/storage-footprint-reporter";
import { LongTermMemoryService } from "../memory/memory-service";
import { VaultCoachPersistentStore } from "../persistent-store";
import { AdvancedRagEngine } from "../rag-engine";
import { EmbeddedExactVectorStore } from "../vector-store";
import { ChatService } from "./chat/chat-service";
import { KnowledgeIndexCoordinator } from "./index/knowledge-index-coordinator";
import { KnowledgeGraphService } from "./graph/knowledge-graph-service";
import { ConceptExtractionService } from "./semantic-graph/concept-extraction-service";
import { SemanticGraphService } from "./semantic-graph/semantic-graph-service";
import { LearningGraphQueryService } from "./learning-graph/learning-graph-query-service";
import { ServiceLearningGraphSource } from "./learning-graph/learning-graph-source";
import { MasteryService } from "./mastery/mastery-service";
import { ProgressService } from "./progress/progress-service";
import { RecommendationService } from "./recommendation/recommendation-service";
import { AdaptiveExamPlanner } from "./exam/adaptive-exam-planner";
import { VaultCoachApplication } from "./vault-coach-application";
import type { TranslationKey } from "../i18n";
import type { KnowledgeIndexViewState } from "./application-api";
import type { VaultCoachSettings } from "./config/settings-types";
import type { ExamEvaluationMetadata, ExamScopeSelection } from "../domain/exam/exam-types";
import type { AssessmentSessionStore } from "../domain/assessment/assessment-types";
import type { VectorStore } from "../domain/retrieval/retrieval-types";
import type { StorageFootprint } from "../domain/index-lifecycle/storage-footprint";

/** Host callbacks needed to connect application services to the Obsidian plugin lifecycle. */
export interface ApplicationContainerDependencies {
    app: App;
    pluginId: string;
    getSettings(): VaultCoachSettings;
    getCloudApiKey(): string | null;
    getDefaultGreeting(): string;
    getKnowledgeScopeDescription(): string;
    ensureKnowledgeBaseReady(): Promise<void>;
    persistRuntimeState(): Promise<void>;
    onGenerationFinished(): void;
    translate(key: TranslationKey, replacements?: Record<string, string | number>): string;
    getFullScopeLabel(): string;
    getNoEligibleChunksMessage(): string;
    normalizeFolderPaths(folderPaths: string[]): string[];
    normalizeSelection(selection: ExamScopeSelection): ExamScopeSelection;
    getIndexState(): KnowledgeIndexViewState;
    rebuildIndex(signal?: AbortSignal): Promise<void>;
    clearIndex(): Promise<void>;
    abortIndex(): void;
    getStorageFootprint(): Promise<StorageFootprint>;
}

/** Concrete services retained for the legacy plugin adapter during incremental migration. */
export interface ApplicationContainerServices {
    knowledgeBase: VaultKnowledgeBase;
    vectorStore: VectorStore;
    ragEngine: AdvancedRagEngine;
    chatService: ChatService;
    examEngine: ExamEngine;
    examEvaluationService: ExamEvaluator;
    examSessionStore: ExamSessionStore;
    assessmentSessionStore: AssessmentSessionStore;
    assessmentEventFactory: AssessmentEventFactory;
    memoryService: LongTermMemoryService;
    persistentStore: VaultCoachPersistentStore;
    storageFootprintReporter: StorageFootprintReporter;
    indexCoordinator: KnowledgeIndexCoordinator;
    knowledgeGraphService: KnowledgeGraphService;
    semanticGraphService: SemanticGraphService;
    learningGraphQueryService: LearningGraphQueryService;
    masteryService: MasteryService;
    progressService: ProgressService;
    recommendationService: RecommendationService;
    adaptiveExamPlanner: AdaptiveExamPlanner;
}

/**
 * Composition boundary for application services.
 *
 * Obsidian-bound infrastructure is created here exactly once. Presentation code
 * only receives the grouped application facade, while the legacy plugin can use
 * `services` until the compatibility adapter is introduced in the next step.
 */
export interface ApplicationContainer {
    application: VaultCoachApplication;
    services: ApplicationContainerServices;
    dispose(): Promise<void>;
}

export function createApplicationContainer(dependencies: ApplicationContainerDependencies): ApplicationContainer {
    const persistentStore = new VaultCoachPersistentStore(dependencies.app, dependencies.pluginId);
    const storageFootprintReporter = new StorageFootprintReporter(dependencies.app.vault.adapter, persistentStore);
    const knowledgeBase = new VaultKnowledgeBase(dependencies.app, () => dependencies.getSettings());
    const vectorStore = new EmbeddedExactVectorStore(persistentStore);
    const chatService = new ChatService(() => dependencies.getSettings());
    const ragEngine = new AdvancedRagEngine(
        knowledgeBase,
        vectorStore,
        () => dependencies.getSettings(),
        () => chatService.getRuntimeRetrievalMode(),
        () => dependencies.getCloudApiKey(),
    );
    const memoryService = new LongTermMemoryService(
        () => dependencies.getSettings(),
        () => chatService.getMessagesForMemory(),
        ragEngine,
    );
    const freeResponseExamEvaluationService = new ExamEvaluationService(
        new LocalModelClient(
            () => dependencies.getSettings(),
            () => dependencies.getCloudApiKey(),
        ),
    );
    const examEvaluationService: ExamEvaluator = new ExamEvaluationRouter(
        freeResponseExamEvaluationService,
        new ObjectiveExamEvaluationService(),
    );
    const examSessionStore = new ExamSessionStore(
        dependencies.app,
        (key, replacements) => dependencies.translate(key, replacements),
    );
    const assessmentSessionStore = new JsonAssessmentSessionStore(dependencies.app.vault.adapter);
    const knowledgeGraphService = new KnowledgeGraphService(
        new ObsidianGraphSourceReader(dependencies.app, knowledgeBase),
        new DeterministicGraphBuilder(),
        new JsonGraphStore(dependencies.app.vault.adapter),
    );
    const semanticModelClient = new LocalModelClient(
        () => dependencies.getSettings(),
        () => dependencies.getCloudApiKey(),
    );
    const semanticGraphService = new SemanticGraphService({
        graphService: knowledgeGraphService,
        documentIndex: knowledgeBase,
        store: new JsonSemanticGraphStore(dependencies.app.vault.adapter),
        extractionService: new ConceptExtractionService(semanticModelClient),
        embeddingGateway: semanticModelClient,
        getSettings: () => dependencies.getSettings(),
        getVectorIndexStats: () => ragEngine.getVectorIndexStats(),
        onStateChanged: () => application?.notifySemanticGraphStateChanged(),
    });
    const learningGraphQueryService = new LearningGraphQueryService(
        new ServiceLearningGraphSource(knowledgeGraphService, semanticGraphService),
    );
    const examEngine = new ExamEngine(
        dependencies.app,
        knowledgeBase,
        new ObsidianDocumentFileMetadataReader(dependencies.app),
        () => dependencies.getSettings(),
        () => dependencies.getCloudApiKey(),
        () => learningGraphQueryService.getConceptIdsByChunk(),
    );
    const masteryService = new MasteryService({
        assessmentSessionStore,
        catalogReader: learningGraphQueryService,
        store: new JsonMasteryStore(dependencies.app.vault.adapter),
        getCapacityAssessment: () => semanticGraphService.getCapacityAssessment(),
    });
    let reviewActionSequence = 0;
    const recommendationService = new RecommendationService({
        learningGraph: learningGraphQueryService,
        mastery: masteryService,
        actionStore: new JsonReviewActionStore(dependencies.app.vault.adapter),
        createEventId: () => createReviewActionEventId(reviewActionSequence++),
    });
    const progressService = new ProgressService({
        catalogReader: learningGraphQueryService,
        masteryReader: masteryService,
        assessmentSessionStore,
        recommendationReader: recommendationService,
    });
    const adaptiveExamPlanner = new AdaptiveExamPlanner({
        learningGraph: learningGraphQueryService,
        mastery: masteryService,
        assessmentSessionStore,
    });
    let assessmentEventSequence = 0;
    const assessmentEventFactory = new AssessmentEventFactory({
        createEventId: () => createAssessmentEventId(assessmentEventSequence++),
    });

    let application: VaultCoachApplication | null = null;
    const indexCoordinator = new KnowledgeIndexCoordinator(() => application?.notifyIndexStateChanged());

    chatService.setDependencies({
        ragEngine,
        memoryService,
        ensureKnowledgeBaseReady: () => dependencies.ensureKnowledgeBaseReady(),
        getKnowledgeScopeDescription: () => dependencies.getKnowledgeScopeDescription(),
        persist: () => dependencies.persistRuntimeState(),
        getDefaultGreeting: () => dependencies.getDefaultGreeting(),
        onGenerationFinished: () => dependencies.onGenerationFinished(),
    });

    const applicationInstance = new VaultCoachApplication({
        chatService,
        examEngine,
        examEvaluationService,
        examSessionStore,
        assessmentSessionStore,
        assessmentEventFactory,
        getAssessmentSavedAt: () => Date.now(),
        getAssessmentSessionPath,
        getAssessmentSessionIdFromPath,
        getScopeOptions: () => {
            const stats = knowledgeBase.getStats();
            return [{
                id: "__all__",
                label: dependencies.getFullScopeLabel(),
                folderPath: null,
                fileCount: stats.fileCount,
                chunkCount: stats.chunkCount,
            }, ...examEngine.getScopeOptions()];
        },
        normalizeFolderPaths: (folderPaths) => dependencies.normalizeFolderPaths(folderPaths),
        normalizeSelection: (selection) => dependencies.normalizeSelection(selection),
        ensureKnowledgeBaseReady: () => dependencies.ensureKnowledgeBaseReady(),
        getFullScopeLabel: () => dependencies.getFullScopeLabel(),
        getNoEligibleChunksMessage: () => dependencies.getNoEligibleChunksMessage(),
        getExamEvaluationMetadata: () => createExamEvaluationMetadata(dependencies.getSettings()),
        getIndexState: () => dependencies.getIndexState(),
        rebuildIndex: (signal) => dependencies.rebuildIndex(signal),
        clearIndex: () => dependencies.clearIndex(),
        abortIndex: () => dependencies.abortIndex(),
        getStorageFootprint: () => dependencies.getStorageFootprint(),
        knowledgeGraphService,
        semanticGraphService,
        learningGraphQueryService,
        masteryService,
        progressService,
        recommendationService,
        adaptiveExamPlanner,
    });
    application = applicationInstance;

    return {
        application: applicationInstance,
        services: {
            knowledgeBase,
            vectorStore,
            ragEngine,
            chatService,
            examEngine,
            examEvaluationService,
            examSessionStore,
            assessmentSessionStore,
            assessmentEventFactory,
            memoryService,
            persistentStore,
            storageFootprintReporter,
            indexCoordinator,
            knowledgeGraphService,
            semanticGraphService,
            learningGraphQueryService,
            masteryService,
            progressService,
            recommendationService,
            adaptiveExamPlanner,
        },
        async dispose(): Promise<void> {
            await applicationInstance.dispose();
            indexCoordinator.dispose();
        },
    };
}

function createAssessmentEventId(sequence: number): string {
    const randomValues = new Uint32Array(2);
    if (window.crypto?.getRandomValues) {
        window.crypto.getRandomValues(randomValues);
        return `assessment-event-${randomValues[0]?.toString(36) ?? "0"}-${randomValues[1]?.toString(36) ?? "0"}-${sequence.toString(36)}`;
    }

    return `assessment-event-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function createReviewActionEventId(sequence: number): string {
    const randomValues = new Uint32Array(2);
    if (window.crypto?.getRandomValues) {
        window.crypto.getRandomValues(randomValues);
        return `review-action-${randomValues[0]?.toString(36) ?? "0"}-${randomValues[1]?.toString(36) ?? "0"}-${sequence.toString(36)}`;
    }

    return `review-action-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function createExamEvaluationMetadata(settings: VaultCoachSettings): ExamEvaluationMetadata {
    return {
        modelProvider: settings.modelProvider,
        modelName: settings.modelProvider === "openai-compatible"
            ? settings.cloudChatModel.trim()
            : settings.chatModel.trim(),
        promptVersion: EXAM_EVALUATION_PROMPT_VERSION,
        evaluatedAt: Date.now(),
    };
}
