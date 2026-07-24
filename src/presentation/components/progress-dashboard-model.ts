import type { ProgressSnapshot, ProgressStateView } from "../../app/progress/progress-types";
import type { GraphCapacityAssessment } from "../../domain/graph-capacity/graph-capacity-types";
import type { MasteryLevel } from "../../domain/mastery/mastery-types";
import { translate, type TranslationKey } from "../../i18n";

export type ProgressDashboardTone = "neutral" | "positive" | "warning" | "error";

export interface ProgressDashboardCard {
    id: "concepts" | "coverage" | "mastery" | "assessments" | "evidence";
    label: string;
    value: string;
    detail: string;
    tone: ProgressDashboardTone;
}

export interface ProgressDashboardLevel {
    level: MasteryLevel;
    label: string;
    count: number;
}

export interface ProgressDashboardStatus {
    message: string;
    tone: ProgressDashboardTone;
}

export interface ProgressDashboardModel {
    cards: readonly ProgressDashboardCard[];
    levels: readonly ProgressDashboardLevel[];
    freshness: ProgressDashboardStatus;
    capacity: ProgressDashboardStatus;
    generatedAt: number;
    latestAssessmentAt: number | null;
}

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/**
 * Converts the Progress read model into bounded, display-ready facts.
 *
 * In particular, null coverage remains "Not calculated" instead of 0%, so
 * the Dashboard never turns missing evidence into a negative learner result.
 */
export function createProgressDashboardModel(
    snapshot: ProgressSnapshot,
    state: ProgressStateView,
    capacity: GraphCapacityAssessment,
    t: TranslateFn = translate,
): ProgressDashboardModel {
    const { graph, mastery, assessments } = snapshot;
    const coverageAvailable = mastery.coverageRatio !== null;
    const evidenceAvailable = mastery.status !== "missing" && mastery.status !== "unavailable";
    const graphReady = graph.status === "ready";
    const assessmentReady = assessments.status === "ready";
    const unassessedConceptCount = Math.max(0, mastery.conceptCount - mastery.assessedConceptCount);
    const assessedDetail = coverageAvailable
        ? t("progress.card.coverageDetail", { assessed: mastery.assessedConceptCount, unassessed: unassessedConceptCount })
        : t("progress.card.coverageUnavailable");
    const cards: readonly ProgressDashboardCard[] = [
        {
            id: "concepts",
            label: t("progress.card.concepts"),
            value: graphReady ? String(graph.conceptCount) : t("progress.value.unavailable"),
            detail: graphReady
                ? t("progress.card.conceptsReady")
                : t("progress.card.conceptsUnavailable"),
            tone: graphReady ? "neutral" : "error",
        },
        {
            id: "coverage",
            label: t("progress.card.coverage"),
            value: mastery.coverageRatio === null ? t("progress.value.notCalculated") : formatPercent(mastery.coverageRatio),
            detail: assessedDetail,
            tone: mastery.status === "current" ? "positive" : mastery.status === "unavailable" ? "error" : "warning",
        },
        {
            id: "mastery",
            label: t("progress.card.mastery"),
            value: describeMasteryStatus(mastery.status, t),
            detail: t("progress.card.evidenceEvents", { count: mastery.sourceEventCount }),
            tone: masteryTone(mastery.status),
        },
        {
            id: "assessments",
            label: t("progress.card.assessments"),
            value: assessmentReady
                ? assessments.sessionCount === 0
                    ? t("progress.card.noAssessments")
                    : t("progress.card.assessmentsScored", { scored: assessments.scoredSessionCount, total: assessments.sessionCount })
                : t("progress.value.unavailable"),
            detail: assessmentReady
                ? assessments.latestSessionAt === null
                    ? t("progress.card.noAssessmentsDetail")
                    : t("progress.card.latestAssessment")
                : t("progress.card.assessmentsUnavailable"),
            tone: assessmentReady ? "neutral" : "error",
        },
        {
            id: "evidence",
            label: t("progress.card.evidence"),
            value: !evidenceAvailable
                ? t("progress.value.notCalculated")
                : mastery.unboundIssueCount === 0
                ? t("progress.card.noBindingIssues")
                : t(mastery.unboundIssueCount === 1 ? "progress.card.bindingIssue" : "progress.card.bindingIssues", {
                    count: mastery.unboundIssueCount,
                }),
            detail: !evidenceAvailable
                ? t("progress.card.evidenceUnavailable")
                : mastery.unboundIssueCount === 0
                ? t("progress.card.evidenceHealthy")
                : t("progress.card.evidenceIssues"),
            tone: !evidenceAvailable
                ? mastery.status === "unavailable" ? "error" : "warning"
                : mastery.unboundIssueCount === 0 ? "positive" : "warning",
        },
    ];

    return {
        cards,
        levels: [
            createLevel("unknown", t("progress.level.unknown"), mastery.levelCounts.unknown),
            createLevel("weak", t("progress.level.weak"), mastery.levelCounts.weak),
            createLevel("developing", t("progress.level.developing"), mastery.levelCounts.developing),
            createLevel("proficient", t("progress.level.proficient"), mastery.levelCounts.proficient),
            createLevel("mastered", t("progress.level.mastered"), mastery.levelCounts.mastered),
        ],
        freshness: createFreshnessStatus(state, t),
        capacity: createCapacityStatus(capacity, t),
        generatedAt: snapshot.generatedAt,
        latestAssessmentAt: assessments.latestSessionAt,
    };
}

function createLevel(level: MasteryLevel, label: string, count: number): ProgressDashboardLevel {
    return { level, label, count };
}

function formatPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function describeMasteryStatus(status: ProgressSnapshot["mastery"]["status"], t: TranslateFn): string {
    switch (status) {
        case "current": return t("progress.mastery.current");
        case "stale": return t("progress.mastery.stale");
        case "missing": return t("progress.mastery.missing");
        case "calculating": return t("progress.mastery.calculating");
        case "unavailable": return t("progress.mastery.unavailable");
    }
}

function masteryTone(status: ProgressSnapshot["mastery"]["status"]): ProgressDashboardTone {
    if (status === "current") return "positive";
    if (status === "unavailable") return "error";
    return "warning";
}

function createFreshnessStatus(state: ProgressStateView, t: TranslateFn): ProgressDashboardStatus {
    if (state.busy) return { message: t("progress.freshness.updating"), tone: "warning" };
    if (state.dirty) return { message: t("progress.freshness.dirty"), tone: "warning" };
    if (state.lastError) return { message: t("progress.freshness.failed"), tone: "error" };
    return { message: t("progress.freshness.current"), tone: "positive" };
}

function createCapacityStatus(capacity: GraphCapacityAssessment, t: TranslateFn): ProgressDashboardStatus {
    switch (capacity.level) {
        case "local":
            return { message: t("progress.capacity.local"), tone: "positive" };
        case "warning":
            return { message: t("progress.capacity.warning"), tone: "warning" };
        case "service-preferred":
            return { message: t("progress.capacity.preferred"), tone: "warning" };
        case "service-required":
            return { message: t("progress.capacity.required"), tone: "error" };
    }
}
