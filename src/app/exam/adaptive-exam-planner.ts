import {
    type AdaptiveExamGenerationContext,
    type AdaptiveExamPlanRequest,
    type AdaptiveExamPlanResult,
    type AdaptiveExamPlanningInput,
    type AdaptiveExamRevisions,
    type AdaptivePlanningConcept,
    type ConfirmedPrerequisite,
} from "../../domain/adaptive-exam/adaptive-exam-types";
import { ADAPTIVE_EXAM_ALGORITHM_VERSION } from "../../domain/adaptive-exam/adaptive-exam-policy";
import { buildAdaptiveExamPlan } from "../../domain/adaptive-exam/adaptive-exam-planner";
import {
    canonicalSerialize,
    createAdaptiveRevisionFingerprint,
} from "../../domain/adaptive-exam/adaptive-exam-fingerprint";
import type { AssessmentEvent, AssessmentSessionDocumentV1, AssessmentSessionStore } from "../../domain/assessment/assessment-types";
import { stableGraphHash } from "../../domain/graph/graph-id";
import type { MasterySnapshotV1, MasteryStateView } from "../../domain/mastery/mastery-types";
import type { LearningGraphConceptCatalog } from "../../domain/learning-graph/learning-graph-types";

/** Narrow read-only contracts keep this coordinator independent from UI and storage details. */
export interface AdaptiveExamPlannerDependencies {
    learningGraph: {
        getConceptCatalog(): LearningGraphConceptCatalog;
        getConfirmedPrerequisites(): readonly ConfirmedPrerequisite[];
        getRevision(): string;
    };
    mastery: {
        getSnapshot(): MasterySnapshotV1 | null;
        getState(): MasteryStateView;
    };
    assessmentSessionStore: Pick<AssessmentSessionStore, "list">;
    now?(): number;
}

interface AssessmentCoverage {
    assessmentCount: number;
    lastAssessedAt: number | null;
}

/**
 * Application coordinator for L6 adaptive planning. It only composes current
 * read models; target ranking remains in the pure domain planner.
 */
export class AdaptiveExamPlanner {
    constructor(private readonly dependencies: AdaptiveExamPlannerDependencies) {}

    async preview(request: AdaptiveExamPlanRequest): Promise<AdaptiveExamPlanResult> {
        const input = await this.createInput(request);
        if (input.concepts.length === 0) {
            return {
                status: "unavailable",
                reasonCode: "no-effective-concepts",
                message: "当前没有可用于自适应选题的有效知识图谱概念；仍可按所选范围生成普通考试。",
            };
        }

        const plan = buildAdaptiveExamPlan(input);
        if (plan.targets.length === 0) {
            return {
                status: "unavailable",
                reasonCode: "no-source-backed-target",
                message: "当前范围内没有同时具备有效图谱证据和可出题片段的概念；仍可按所选范围生成普通考试。",
            };
        }
        return plan.appliedFallbacks.length > 0
            ? { status: "degraded", plan, reasonCode: plan.appliedFallbacks[0] ?? "insufficient-evidence" }
            : { status: "ready", plan };
    }

    /**
     * Checks only facts that invalidate a visible plan.  It deliberately does
     * not compare planning time, so waiting on the setup screen does not make
     * a plan stale by itself.
     */
    async isCurrent(context: AdaptiveExamGenerationContext, request: AdaptiveExamPlanRequest): Promise<boolean> {
        if (context.algorithmVersion !== ADAPTIVE_EXAM_ALGORITHM_VERSION
            || context.examMode !== request.examMode
            || context.targetMode !== request.targetMode) {
            return false;
        }
        const input = await this.createInput(request);
        return context.scopeSignature === input.scope.signature
            && context.revisionFingerprint === createAdaptiveRevisionFingerprint(input.scope.signature, input.revisions);
    }

    private async createInput(request: AdaptiveExamPlanRequest): Promise<AdaptiveExamPlanningInput> {
        const catalog = this.dependencies.learningGraph.getConceptCatalog();
        const [documents, snapshot] = await Promise.all([
            this.dependencies.assessmentSessionStore.list(),
            Promise.resolve(this.dependencies.mastery.getSnapshot()),
        ]);
        const scope = createScopeSnapshot(request);
        const coverageByConceptId = createAssessmentCoverage(documents);
        const masteryByConceptId = new Map((snapshot?.states ?? []).map((state) => [state.conceptId, state]));
        const concepts: AdaptivePlanningConcept[] = catalog.concepts
            .map((concept) => {
                const mastery = masteryByConceptId.get(concept.id);
                const coverage = coverageByConceptId.get(concept.id);
                return {
                    id: concept.id,
                    label: concept.label,
                    sourceChunkIds: [...concept.sourceChunkIds],
                    masteryScore: mastery?.masteryScore ?? null,
                    confidence: mastery?.confidence ?? 0,
                    level: mastery?.level ?? "unknown",
                    assessmentCount: mastery?.assessmentCount ?? coverage?.assessmentCount ?? 0,
                    lastAssessedAt: mastery?.lastAssessedAt ?? coverage?.lastAssessedAt ?? null,
                    nextReviewAt: mastery?.nextReviewAt ?? null,
                };
            })
            .sort((left, right) => left.id.localeCompare(right.id));
        const revisions = createRevisions(
            request,
            this.dependencies.learningGraph.getRevision(),
            snapshot,
            this.dependencies.mastery.getState(),
            documents,
        );
        return {
            algorithmVersion: ADAPTIVE_EXAM_ALGORITHM_VERSION,
            planningAt: this.dependencies.now?.() ?? Date.now(),
            scope,
            examMode: request.examMode,
            targetMode: request.targetMode,
            requestedQuestionCount: request.questionCount,
            revisions,
            concepts,
            confirmedPrerequisites: catalog.sourceReady
                ? [...this.dependencies.learningGraph.getConfirmedPrerequisites()]
                : [],
        };
    }
}

function createScopeSnapshot(request: AdaptiveExamPlanRequest): AdaptiveExamPlanningInput["scope"] {
    const selection = request.selection;
    const eligibleChunkIds = Array.from(new Set(request.analysis.eligibleChunkIds))
        .sort((left, right) => left.localeCompare(right));
    return {
        signature: stableGraphHash(canonicalSerialize({
            selectedFolderPaths: [...selection.selectedFolderPaths].sort((left, right) => left.localeCompare(right)),
            excludedFilePaths: [...selection.excludedFilePaths].sort((left, right) => left.localeCompare(right)),
            forceIncludedFilePaths: [...selection.forceIncludedFilePaths].sort((left, right) => left.localeCompare(right)),
            eligibleChunkIds,
        })),
        eligibleChunkIds,
    };
}

function createRevisions(
    request: AdaptiveExamPlanRequest,
    effectiveGraphRevision: string,
    snapshot: MasterySnapshotV1 | null,
    masteryState: MasteryStateView,
    documents: readonly AssessmentSessionDocumentV1[],
): AdaptiveExamRevisions {
    return {
        indexRevision: stableGraphHash(canonicalSerialize({
            promptVersion: request.analysis.promptVersion,
            eligibleChunkIds: [...request.analysis.eligibleChunkIds].sort((left, right) => left.localeCompare(right)),
            profiles: request.analysis.profiles.map((profile) => ({
                filePath: profile.filePath,
                decision: profile.decision,
                confidence: profile.confidence,
                eligibleHeadingPaths: profile.eligibleHeadingPaths,
                excludedHeadingPaths: profile.excludedHeadingPaths,
            })).sort((left, right) => left.filePath.localeCompare(right.filePath)),
        })),
        effectiveGraphRevision,
        masteryRevision: stableGraphHash(canonicalSerialize({
            snapshot: snapshot ? {
                algorithmVersion: snapshot.algorithmVersion,
                calculatedAt: snapshot.calculatedAt,
                states: snapshot.states.map((state) => ({
                    conceptId: state.conceptId,
                    masteryScore: state.masteryScore,
                    confidence: state.confidence,
                    assessmentCount: state.assessmentCount,
                    lastAssessedAt: state.lastAssessedAt,
                    nextReviewAt: state.nextReviewAt,
                })).sort((left, right) => left.conceptId.localeCompare(right.conceptId)),
            } : null,
            dirty: masteryState.dirty,
            algorithmVersion: masteryState.algorithmVersion,
        })),
        assessmentRevision: stableGraphHash(canonicalSerialize(documents
            .map((document) => ({
                sessionId: document.sessionId,
                savedAt: document.savedAt,
                events: document.assessmentEvents.map((event) => ({
                    id: event.id,
                    occurredAt: event.occurredAt,
                    supersedesEventId: event.supersedesEventId ?? null,
                })).sort((left, right) => left.id.localeCompare(right.id)),
            }))
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId)))),
    };
}

function createAssessmentCoverage(documents: readonly AssessmentSessionDocumentV1[]): Map<string, AssessmentCoverage> {
    const allEvents = documents.flatMap((document) => document.assessmentEvents);
    const supersededEventIds = new Set(allEvents
        .flatMap((event) => event.supersedesEventId ? [event.supersedesEventId] : []));
    const coverageByConceptId = new Map<string, AssessmentCoverage>();
    for (const event of allEvents
        .filter((item) => !supersededEventIds.has(item.id))
        .sort(compareAssessmentEvents)) {
        appendCoverage(coverageByConceptId, event);
    }
    return coverageByConceptId;
}

function appendCoverage(coverageByConceptId: Map<string, AssessmentCoverage>, event: AssessmentEvent): void {
    for (const conceptId of Array.from(new Set(event.conceptIds)).sort((left, right) => left.localeCompare(right))) {
        const previous = coverageByConceptId.get(conceptId) ?? { assessmentCount: 0, lastAssessedAt: null };
        coverageByConceptId.set(conceptId, {
            assessmentCount: previous.assessmentCount + 1,
            lastAssessedAt: Math.max(previous.lastAssessedAt ?? 0, event.occurredAt) || null,
        });
    }
}

function compareAssessmentEvents(left: AssessmentEvent, right: AssessmentEvent): number {
    return left.occurredAt - right.occurredAt || left.id.localeCompare(right.id);
}
