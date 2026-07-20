import type {
    AssessmentErrorCode,
    ExamDifficulty,
    ExamQuestionType,
    ExamSession,
} from "../exam/exam-types";

/** Increment when the persisted assessment-session document changes incompatibly. */
export const ASSESSMENT_SESSION_SCHEMA_VERSION = 1;
export const ASSESSMENT_INDEX_SCHEMA_VERSION = 1;

/** Immutable evidence produced by one evaluated answer. */
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
    };
    supersedesEventId?: string;
}

/** Human-readable mapping for M1 provisional topic IDs; it is not a graph node. */
export interface AssessmentConceptBinding {
    id: string;
    label: string;
    sourceBlueprintItemId: string;
    kind: "provisional-topic";
}

/** Facts that will be persisted by the M1 JSON store in the following step. */
export interface AssessmentSessionDocumentV1 {
    schemaVersion: typeof ASSESSMENT_SESSION_SCHEMA_VERSION;
    sessionId: string;
    savedAt: number;
    examSession: ExamSession;
    assessmentEvents: AssessmentEvent[];
    conceptBindings: AssessmentConceptBinding[];
}

/** Compact session metadata used to list history without loading every full document. */
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

/** Result returned by the pure event factory before any storage side effect occurs. */
export interface AssessmentEventCreationResult {
    events: AssessmentEvent[];
    conceptBindings: AssessmentConceptBinding[];
}

/** Domain port to be implemented by M1's JSON assessment-session store. */
export interface AssessmentSessionStore {
    save(document: AssessmentSessionDocumentV1): Promise<void>;
    read(sessionId: string): Promise<AssessmentSessionDocumentV1 | null>;
    list(): Promise<AssessmentSessionDocumentV1[]>;
    rebuildIndex(): Promise<AssessmentSessionIndexV1>;
}
