export type ExamSessionStatus = "draft" | "submitted" | "saved";

export interface ExamScopeOption {
    id: string;
    label: string;
    folderPath: string | null;
    fileCount: number;
    chunkCount: number;
}

export type ExamContentDecision = "include" | "partial" | "exclude";

export type ExamExclusionReason =
    | "task-list"
    | "temporary-log"
    | "empty-or-stub"
    | "link-index"
    | "raw-output"
    | "duplicated-content"
    | "insufficient-context"
    | "not-answerable"
    | "low-learning-value"
    | "mixed-content"
    | "user-rule"
    | "other";

export interface ExamFileOption {
    filePath: string;
    fileName: string;
    parentFolder: string;
    chunkCount: number;
    permanentlyExcluded: boolean;
    permanentExcludeReason?: string;
    smartDecision?: ExamContentDecision;
    smartReasonCodes?: ExamExclusionReason[];
}

export interface ExamScopeSelection {
    selectedFolderPaths: string[];
    excludedFilePaths: string[];
    forceIncludedFilePaths: string[];
}

export interface ExamScopeSnapshot {
    totalFileCount: number;
    eligibleFileCount: number;
    excludedFileCount: number;
    eligibleChunkCount: number;
    estimatedMinQuestions: number;
    estimatedMaxQuestions: number;
}

export type ExamGenerationPhase =
    | "resolving-scope"
    | "rule-filtering"
    | "semantic-filtering"
    | "planning"
    | "generating"
    | "validating"
    | "repairing"
    | "completed";

export interface ExamContentProfile {
    filePath: string;
    decision: ExamContentDecision;
    confidence: number;
    reasonCodes: ExamExclusionReason[];
    eligibleHeadingPaths: string[][];
    excludedHeadingPaths: string[][];
    topics: string[];
    estimatedQuestionCapacity: number;
}

export interface ExamContentProfileCacheKey {
    filePath: string;
    contentHash: string;
    modelProvider: string;
    modelName: string;
    promptVersion: string;
}

export interface ExamContentProfileCacheRecord extends ExamContentProfileCacheKey {
    profile: ExamContentProfile;
    updatedAt: number;
}

export interface ExamContentProfileCache {
    version: number;
    records: ExamContentProfileCacheRecord[];
}

export interface ExamScopeAnalysisSummary {
    totalFiles: number;
    ruleExcludedFiles: number;
    manualExcludedFiles: number;
    semanticExcludedFiles: number;
    partialFiles: number;
    includedFiles: number;
    eligibleChunkCount: number;
    estimatedMinQuestions: number;
    estimatedMaxQuestions: number;
    cacheHits: number;
    cacheMisses: number;
}

export interface ExamScopeAnalysisResult {
    selection: ExamScopeSelection;
    profiles: ExamContentProfile[];
    summary: ExamScopeAnalysisSummary;
    eligibleChunkIds: string[];
    promptVersion: string;
}

export interface ExamGenerationProgress {
    phase: ExamGenerationPhase;
    label: string;
    current?: number;
    total?: number;
}

export interface ExamGenerationOptions {
    analysis?: ExamScopeAnalysisResult;
    forceProfileRefresh?: boolean;
    skipSemanticFiltering?: boolean;
    abortSignal?: AbortSignal;
    onProgress?: (progress: ExamGenerationProgress) => void;
}

export interface GeneratedExamQuestionCandidate {
    id?: string;
    blueprintItemId: string;
    question: string;
    referenceAnswer: string;
    rubric: string;
    sourceChunkIds: string[];
    evidenceExcerptIds: string[];
}

export interface ExamQuestionReview {
    questionId: string;
    passed: boolean;
    groundedness: number;
    answerability: number;
    learningValue: number;
    clarity: number;
    uniqueness: number;
    failureCodes: string[];
    repairInstruction: string;
}

export interface ExamGenerationDiagnostics {
    totalFiles: number;
    ruleExcludedFiles: number;
    semanticExcludedFiles: number;
    partialFiles: number;
    eligibleChunks: number;
    requestedQuestions: number;
    plannedQuestions: number;
    firstPassQuestions: number;
    repairedQuestions: number;
    finalQuestions: number;
    cacheHits: number;
    cacheMisses: number;
    durations: {
        scopeMs: number;
        profilingMs: number;
        planningMs: number;
        generationMs: number;
        validationMs: number;
    };
}

export interface ExamBlueprintItem {
    id: string;
    topic: string;
    learningObjective: string;
    questionType: "explanation" | "comparison" | "application" | "reasoning" | "process";
    difficulty: "basic" | "intermediate" | "advanced";
    sourceChunkIds: string[];
}

export interface ExamBlueprint {
    title: string;
    requestedQuestionCount: number;
    plannedQuestionCount: number;
    items: ExamBlueprintItem[];
}

export interface ExamQuestion {
    id: string;
    question: string;
    referenceAnswer: string;
    rubric: string;
    sourcePaths: string[];
}

export interface ExamEvaluationItem {
    questionId: string;
    score: number;
    maxScore: number;
    feedback: string;
    improvement: string;
}

export interface ExamEvaluation {
    score: number;
    maxScore: number;
    overallFeedback: string;
    items: ExamEvaluationItem[];
}

export interface ExamSession {
    id: string;
    title: string;
    createdAt: number;
    scopeLabel: string;
    selectedFolderPaths: string[];
    excludedFilePaths: string[];
    forceIncludedFilePaths: string[];
    scopeSnapshot?: ExamScopeSnapshot;
    analysisSummary?: ExamScopeAnalysisSummary;
    blueprint?: ExamBlueprint;
    qualityNotice?: string;
    diagnostics?: ExamGenerationDiagnostics;
    questions: ExamQuestion[];
    userAnswers: string[];
    evaluation: ExamEvaluation | null;
    savedPath: string | null;
    status: ExamSessionStatus;
}

export interface ExamHistoryItem {
    path: string;
    title: string;
    createdAt: number | null;
    score: number | null;
    maxScore: number | null;
    modifiedAt: number | null;
}
