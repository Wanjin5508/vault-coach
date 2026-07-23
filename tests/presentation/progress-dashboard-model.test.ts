import { describe, expect, it } from "vitest";
import { createProgressDashboardModel } from "../../src/presentation/components/progress-dashboard-model";
import type { ProgressSnapshot, ProgressStateView } from "../../src/app/progress/progress-types";
import type { GraphCapacityAssessment } from "../../src/domain/graph-capacity/graph-capacity-types";
import { translate } from "../../src/i18n";

describe("createProgressDashboardModel", () => {
    it("turns current local Progress facts into bounded display cards", () => {
        const model = createProgressDashboardModel(createSnapshot(), createState(), createCapacity());

        expect(model.cards).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "concepts", value: "3", tone: "neutral" }),
            expect.objectContaining({ id: "coverage", value: "67%", detail: "2 assessed · 1 not yet assessed.", tone: "positive" }),
            expect.objectContaining({ id: "mastery", value: "Current", tone: "positive" }),
            expect.objectContaining({ id: "assessments", value: "1/2 scored", tone: "neutral" }),
            expect.objectContaining({ id: "evidence", value: "1 issue", tone: "warning" }),
        ]));
        expect(model.levels).toEqual([
            { level: "unknown", label: "Unknown", count: 1 },
            { level: "weak", label: "Weak", count: 1 },
            { level: "developing", label: "Developing", count: 0 },
            { level: "proficient", label: "Proficient", count: 0 },
            { level: "mastered", label: "Mastered", count: 1 },
        ]);
        expect(model.freshness).toEqual({ message: "Local dashboard data is current.", tone: "positive" });
        expect(model.capacity).toEqual({ message: "Local graph capacity is within the Lite budget.", tone: "positive" });
    });

    it("keeps missing coverage and unavailable sources explicit instead of displaying zero", () => {
        const snapshot = createSnapshot({
            graph: { status: "unavailable", conceptCount: 0, message: "Rebuild graph first." },
            mastery: {
                ...createSnapshot().mastery,
                status: "missing",
                message: "No mastery snapshot.",
                conceptCount: 0,
                assessedConceptCount: 0,
                coverageRatio: null,
            },
            assessments: { status: "unavailable", message: "History unavailable.", sessionCount: 0, scoredSessionCount: 0, latestSessionAt: null },
        });
        const model = createProgressDashboardModel(snapshot, createState({ dirty: true }), createCapacity("service-preferred"));

        expect(model.cards.find((card) => card.id === "coverage")).toMatchObject({ value: "Not calculated", tone: "warning" });
        expect(model.cards.find((card) => card.id === "concepts")).toMatchObject({ value: "Unavailable", tone: "error" });
        expect(model.cards.find((card) => card.id === "assessments")).toMatchObject({ value: "Unavailable", tone: "error" });
        expect(model.cards.find((card) => card.id === "evidence")).toMatchObject({ value: "Not calculated", tone: "warning" });
        expect(model.freshness.tone).toBe("warning");
        expect(model.capacity.tone).toBe("warning");
    });

    it("renders display statuses in the selected Obsidian locale instead of exposing raw service messages", () => {
        const snapshot = createSnapshot({
            graph: { status: "unavailable", conceptCount: 0, message: "Rebuild graph first." },
            mastery: {
                ...createSnapshot().mastery,
                status: "unavailable",
                message: "Mastery data is unavailable.",
                coverageRatio: null,
            },
            assessments: { status: "unavailable", message: "History unavailable.", sessionCount: 0, scoredSessionCount: 0, latestSessionAt: null },
        });
        const zh = (key: Parameters<typeof translate>[0], replacements?: Record<string, string | number>) => (
            translate(key, replacements, "zh")
        );

        const model = createProgressDashboardModel(snapshot, createState(), createCapacity(), zh);

        expect(model.cards.find((card) => card.id === "concepts")).toMatchObject({
            label: "已确认概念",
            value: "不可用",
            detail: "请先重建知识索引和确定性结构图谱。",
        });
        expect(model.cards.find((card) => card.id === "mastery")).toMatchObject({
            label: "掌握度状态",
            value: "不可用",
        });
        expect(model.cards.map((card) => card.detail).join(" ")).not.toContain("Mastery data is unavailable.");
    });
});

function createSnapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
    return {
        schemaVersion: 1,
        generatedAt: 1_700_000_000_000,
        graph: { status: "ready", conceptCount: 3, message: null },
        mastery: {
            status: "current",
            message: null,
            conceptCount: 3,
            assessedConceptCount: 2,
            coverageRatio: 2 / 3,
            levelCounts: { unknown: 1, weak: 1, developing: 0, proficient: 0, mastered: 1 },
            snapshotCalculatedAt: 1_700_000_000_000,
            algorithmVersion: "mastery/v1",
            sourceEventCount: 6,
            unboundIssueCount: 1,
        },
        assessments: { status: "ready", message: null, sessionCount: 2, scoredSessionCount: 1, latestSessionAt: 1_700_000_010_000 },
        recommendations: [],
        ...overrides,
    };
}

function createState(overrides: Partial<ProgressStateView> = {}): ProgressStateView {
    return {
        hasSnapshot: true,
        dirty: false,
        busy: false,
        lastError: null,
        generatedAt: 1_700_000_000_000,
        ...overrides,
    };
}

function createCapacity(level: GraphCapacityAssessment["level"] = "local"): GraphCapacityAssessment {
    return {
        level,
        reasons: [],
        rawVectorBytes: null,
        hasUnknownMetrics: false,
        allowManualSemanticBuild: level !== "service-required",
        allowAutomaticSemanticSync: level === "local",
    };
}
