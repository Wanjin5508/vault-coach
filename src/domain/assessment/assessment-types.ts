import type {
    AssessmentErrorCode,
    ExamDifficulty,
    ExamHistoryItem,
    ExamQuestionType,
    ExamSession,
} from "../exam/exam-types";
import type { AdaptiveTargetMode } from "../adaptive-exam/adaptive-exam-types";

/** 持久化 Assessment Session 文档发生不兼容变更时递增。 */
export const ASSESSMENT_SESSION_SCHEMA_VERSION = 1;
export const ASSESSMENT_INDEX_SCHEMA_VERSION = 1;

/** 单个已评估答案产生的不可变证据。 */
export interface AssessmentEvent {
    id: string;
    eventType: "exam-answer";
    sessionId: string;
    questionId: string;
    conceptIds: string[];
    sourceChunkIds: string[];
    rawScore: number;
    normalizedScore: number;
    difficulty: ExamDifficulty;
    questionType: ExamQuestionType;
    errorCodes: AssessmentErrorCode[];
    evidenceConfidence: number;
    evaluationConfidence: number;
    occurredAt: number;
    evaluator: {
        provider: string;
        model: string;
        promptVersion: string;
        /** 追加式审计详情；不得改变 Mastery 权重。 */
        kind?: "model" | "deterministic";
    };
    /** 仅用于审计的关联；Mastery 仍只消费 `conceptIds` 和来源。 */
    adaptive?: {
        planId: string;
        targetMode: AdaptiveTargetMode;
        plannedTargetConceptIds: string[];
    };
    supersedesEventId?: string;
}

/** M1 临时主题 ID 的可读映射；该对象不是图节点。 */
export interface AssessmentConceptBinding {
    id: string;
    label: string;
    sourceBlueprintItemId: string;
    kind: "provisional-topic";
}

/** 下一步由 M1 JSON 存储持久化的事实。 */
export interface AssessmentSessionDocumentV1 {
    schemaVersion: typeof ASSESSMENT_SESSION_SCHEMA_VERSION;
    sessionId: string;
    savedAt: number;
    examSession: ExamSession;
    assessmentEvents: AssessmentEvent[];
    conceptBindings: AssessmentConceptBinding[];
}

/** 用于列出历史记录的紧凑会话元数据，避免加载每个完整文档。 */
export interface AssessmentSessionIndexEntry {
    sessionId: string;
    sessionPath: string;
    reportPath: string | null;
    title: string;
    createdAt: number;
    score: number | null;
    maxScore: number | null;
    updatedAt: number;
}

export interface AssessmentSessionIndexV1 {
    schemaVersion: typeof ASSESSMENT_INDEX_SCHEMA_VERSION;
    entries: AssessmentSessionIndexEntry[];
}

/** 以 Assessment Session JSON 为事实来源的历史记录项。 */
export interface AssessmentExamHistoryItem extends ExamHistoryItem {
    sessionId: string;
    sessionPath: string;
    reportPath: string | null;
}

/** 纯事件工厂在产生任何存储副作用前返回的结果。 */
export interface AssessmentEventCreationResult {
    events: AssessmentEvent[];
    conceptBindings: AssessmentConceptBinding[];
}

/** 由 M1 JSON Assessment Session 存储实现的领域端口。 */
export interface AssessmentSessionStore {
    save(document: AssessmentSessionDocumentV1): Promise<void>;
    read(sessionId: string): Promise<AssessmentSessionDocumentV1 | null>;
    list(): Promise<AssessmentSessionDocumentV1[]>;
    listHistory(): Promise<AssessmentExamHistoryItem[]>;
    rebuildIndex(): Promise<AssessmentSessionIndexV1>;
}
