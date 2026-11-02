export const VECTOR_BUILD_JOB_SCHEMA_VERSION = 1 as const;

export type VectorBuildJobPhase =
    | "queued"
    | "preparing-model"
    | "embedding"
    | "persisting-vector"
    | "validating"
    | "rag-ready"
    | "stale"
    | "failed"
    | "cancelled"
    | "superseded";

export interface VectorBuildJob {
    schemaVersion: typeof VECTOR_BUILD_JOB_SCHEMA_VERSION;
    jobId: string;
    sourceCoreGenerationId: string;
    embeddingPolicyId: string;
    phase: VectorBuildJobPhase;
    createdAt: number;
    updatedAt: number;
    vectorCount: number;
    errorCode: string | null;
}

export function isVectorBuildJob(value: unknown): value is VectorBuildJob {
    if (!isRecord(value)) return false;
    return value.schemaVersion === VECTOR_BUILD_JOB_SCHEMA_VERSION
        && typeof value.jobId === "string"
        && typeof value.sourceCoreGenerationId === "string"
        && typeof value.embeddingPolicyId === "string"
        && isPhase(value.phase)
        && isNonNegativeNumber(value.createdAt)
        && isNonNegativeNumber(value.updatedAt)
        && isNonNegativeNumber(value.vectorCount)
        && (value.errorCode === null || typeof value.errorCode === "string");
}

export function isVectorBuildJobTerminal(phase: VectorBuildJobPhase): boolean {
    return phase === "rag-ready" || phase === "stale" || phase === "failed"
        || phase === "cancelled" || phase === "superseded";
}

function isPhase(value: unknown): value is VectorBuildJobPhase {
    return value === "queued" || value === "preparing-model" || value === "embedding"
        || value === "persisting-vector" || value === "validating" || value === "rag-ready"
        || value === "stale" || value === "failed" || value === "cancelled" || value === "superseded";
}

function isNonNegativeNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
