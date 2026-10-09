import type { AdaptiveExamGenerationContext, AdaptivePlanAuditSnapshot } from "../adaptive-exam/adaptive-exam-types";

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
    /** 当前创建会话面向用户的生成策略。 */
    examMode?: ExamMode;
    /** 已验证、可重建的目标方案；`undefined` 表示保留旧版仅范围流程。 */
    adaptivePlan?: AdaptiveExamGenerationContext;
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
    /** 候选项的 UI/答案契约；为兼容旧生成器 fixture 保持可选。 */
    answerForm?: ExamAnswerForm;
    options?: ExamChoiceOption[];
    correctOptionId?: string;
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
    questionType: ExamQuestionType;
    difficulty: ExamDifficulty;
    /** 与认知层 `questionType` 分离，用于决定学习者的作答方式。 */
    /** `undefined` 表示旧版自由回答蓝图项。 */
    answerForm?: ExamAnswerForm;
    /** 简短、可审计的规划说明，仅用于生成诊断。 */
    selectionRationale?: string;
    /** 已接受自适应方案为该题选择的有效 Concept。 */
    plannedTargetConceptIds?: string[];
    sourceChunkIds: string[];
}

export interface ExamBlueprint {
    title: string;
    requestedQuestionCount: number;
    plannedQuestionCount: number;
    items: ExamBlueprintItem[];
}

export type ExamQuestionType = "explanation" | "comparison" | "application" | "reasoning" | "process";

export type ExamDifficulty = "basic" | "intermediate" | "advanced";

/** 会话级体验策略，不得与单题 `ExamDifficulty` 混淆。 */
export type ExamMode = "simple" | "challenge";

/** 已生成问题的作答 UI 与评估路径。 */
export type ExamAnswerForm = "single-choice" | "true-false" | "free-response";

/** 持久化稳定选项标识，而不是展示序号或翻译后的标签。 */
export interface ExamChoiceOption {
    id: string;
    text: string;
}

/** 标识生成领域值时使用的模型和提示词契约。 */
export interface ModelPromptMetadata {
    modelProvider: string;
    modelName: string;
    promptVersion: string;
}

/** 标识完成评估时使用的模型和提示词契约。 */
export interface ExamEvaluationMetadata extends ModelPromptMetadata {
    evaluatedAt: number;
    /** 既有会话由模型评分；客观题必须显式声明确定性评分。 */
    evaluatorKind?: "model" | "deterministic";
}

export type AssessmentErrorCode =
    | "missing-key-point"
    | "concept-confusion"
    | "incorrect-causal-relation"
    | "incorrect-definition"
    | "incomplete-process"
    | "incorrect-application"
    | "unsupported-claim"
    | "irrelevant-answer"
    | "no-answer"
    | "other";

export interface ExamQuestion {
    id: string;
    blueprintItemId: string;
    question: string;
    referenceAnswer: string;
    rubric: string;
    questionType: ExamQuestionType;
    difficulty: ExamDifficulty;
    /** 旧记录中为 `undefined`，因此按自由回答解释。 */
    answerForm?: ExamAnswerForm;
    /** 仅客观题必须存在。 */
    options?: ExamChoiceOption[];
    /** 仅客观题必须存在，且不得在作答界面中渲染。 */
    correctOptionId?: string;
    sourceChunkIds: string[];
    evidenceExcerptIds: string[];
    sourcePaths: string[];
    conceptIds: string[];
    /** 自适应方案显式选择的 `conceptIds` 子集；没有方案时为空。 */
    plannedTargetConceptIds?: string[];
    generationMetadata: ModelPromptMetadata & {
        generatedAt: number;
    };
}

export interface ExamEvaluationItem {
    questionId: string;
    score: number;
    maxScore: number;
    feedback: string;
    improvement: string;
    coveredKeyPoints: string[];
    missingKeyPoints: string[];
    errorCodes: AssessmentErrorCode[];
    evaluationConfidence: number;
    evaluator: ExamEvaluationMetadata;
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
    /** 旧记录中为 `undefined`；当前 UI 将此类会话作为旧版自由回答会话处理。 */
    examMode?: ExamMode;
    /** 追加式审计快照；原始图和 Mastery 事实继续保留在各自事实来源中。 */
    adaptivePlan?: AdaptivePlanAuditSnapshot;
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
