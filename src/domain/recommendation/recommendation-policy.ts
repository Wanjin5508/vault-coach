/**
 * 建议排序的版本化策略参数。
 *
 * 所有权重只表达相对优先级；修改任何参数时必须同步评估算法版本和排序回归测试。
 */
export const RECOMMENDATION_ALGORITHM_VERSION = "recommendation/v1";
export const RECOMMENDATION_POLICY = {
    maxPrimary: 5,
    lowConfidenceThreshold: 0.45,
    recentAssessmentMs: 7 * 24 * 60 * 60 * 1000,
    tiers: {
        weakMastery: 500,
        reviewDue: 420,
        developingMastery: 340,
        confirmedPrerequisite: 300,
        importancePerRelation: 25,
        maxImportanceBonus: 100,
        unassessed: 260,
        lowConfidence: 200,
        recentlyCoveredPenalty: 80,
    },
} as const;
