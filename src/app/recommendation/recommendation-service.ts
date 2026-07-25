import { buildRecommendations } from "../../domain/recommendation/recommendation-planner";
import { RECOMMENDATION_ALGORITHM_VERSION, RECOMMENDATION_POLICY } from "../../domain/recommendation/recommendation-policy";
import type { Recommendation, RecommendationSnapshot, ReviewAction, ReviewActionStore } from "../../domain/recommendation/recommendation-types";
import type { LearningGraphConceptCatalog } from "../../domain/learning-graph/learning-graph-types";
import type { MasterySnapshotV1 } from "../../domain/mastery/mastery-types";
import type { ConfirmedPrerequisite } from "../../domain/adaptive-exam/adaptive-exam-types";

export interface RecommendationServiceDependencies {
    learningGraph: { getConceptCatalog(): LearningGraphConceptCatalog; getConfirmedPrerequisites(): readonly ConfirmedPrerequisite[]; };
    mastery: { getSnapshot(): MasterySnapshotV1 | null; };
    actionStore: ReviewActionStore;
    createEventId(): string;
    now?(): number;
}

export class RecommendationService {
    private dirty = true;
    private snapshot: RecommendationSnapshot | null = null;
    constructor(private readonly dependencies: RecommendationServiceDependencies) {}

    invalidate(): void { this.dirty = true; }

    async getSnapshot(): Promise<RecommendationSnapshot> {
        if (this.snapshot && !this.dirty) return cloneSnapshot(this.snapshot);
        const catalog = this.dependencies.learningGraph.getConceptCatalog();
        const now = this.now();
        const masteryById = new Map((this.dependencies.mastery.getSnapshot()?.states ?? []).map((state) => [state.conceptId, state]));
        const queue = catalog.sourceReady ? buildRecommendations({
            algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
            generatedAt: now,
            concepts: catalog.concepts.map((concept) => {
                const state = masteryById.get(concept.id);
                return { id: concept.id, label: concept.label, sourceChunkIds: concept.sourceChunkIds, masteryScore: state?.masteryScore ?? null, confidence: state?.confidence ?? 0, level: state?.level ?? "unknown", assessmentCount: state?.assessmentCount ?? 0, lastAssessedAt: state?.lastAssessedAt ?? null, nextReviewAt: state?.nextReviewAt ?? null };
            }),
            prerequisites: this.dependencies.learningGraph.getConfirmedPrerequisites(),
            actionEvents: await this.dependencies.actionStore.list(),
        }) : [];
        this.snapshot = { algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION, generatedAt: now, primary: queue.filter((item) => item.actionState === "open").slice(0, RECOMMENDATION_POLICY.maxPrimary), queue };
        this.dirty = false;
        return cloneSnapshot(this.snapshot);
    }

    async recordAction(recommendationId: string, action: ReviewAction, deferUntil?: number): Promise<void> {
        await this.dependencies.actionStore.append({ id: this.dependencies.createEventId(), recommendationId, action, occurredAt: this.now(), ...(deferUntil === undefined ? {} : { deferUntil }) });
        this.invalidate();
    }

    private now(): number { return this.dependencies.now?.() ?? Date.now(); }
}

function cloneSnapshot(snapshot: RecommendationSnapshot): RecommendationSnapshot {
    const clone = (item: Recommendation): Recommendation => ({ ...item, targetConceptIds: [...item.targetConceptIds], sourceChunkIds: [...item.sourceChunkIds], reasonCodes: [...item.reasonCodes] });
    return { ...snapshot, primary: snapshot.primary.map(clone), queue: snapshot.queue.map(clone) };
}
