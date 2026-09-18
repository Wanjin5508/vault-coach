export const ADAPTIVE_EXAM_ALGORITHM_VERSION = "adaptive-exam/v1";

export const ADAPTIVE_EXAM_POLICY = {
    maxQuestionCount: 10,
    maxSourceChunksPerTarget: 3,
    lowConfidenceThreshold: 0.45,
    cooldownMs: 7 * 24 * 60 * 60 * 1000,
    reasonTiers: {
        unassessed: 500,
        weakMastery: 400,
        reviewDue: 350,
        developingMastery: 300,
        lowConfidence: 200,
        confirmedPrerequisite: 250,
        recentlyCovered: 20,
    },
} as const;
