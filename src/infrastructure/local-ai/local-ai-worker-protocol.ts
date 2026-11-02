export const LOCAL_AI_WORKER_PROTOCOL_VERSION = 1 as const;

export type LocalAiWorkerRole = "embedding" | "reranker" | "utility";
export type LocalAiWorkerOperation = "prepare" | "embed" | "rerank" | "utility" | "cancel" | "clear" | "dispose";

export interface LocalAiWorkerRequest {
    v: typeof LOCAL_AI_WORKER_PROTOCOL_VERSION;
    requestId: string;
    jobId: string;
    workerEpoch: number;
    role: LocalAiWorkerRole;
    policyId: string;
    operation: LocalAiWorkerOperation;
    payload: Record<string, unknown>;
}

export interface LocalAiWorkerResponse {
    v: typeof LOCAL_AI_WORKER_PROTOCOL_VERSION;
    type: "response";
    requestId: string;
    jobId: string;
    workerEpoch: number;
    role: LocalAiWorkerRole;
    policyId: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; recoverable: boolean; safeMessage: string };
}

export interface LocalAiWorkerProgress {
    v: typeof LOCAL_AI_WORKER_PROTOCOL_VERSION;
    type: "progress";
    requestId: string;
    jobId: string;
    workerEpoch: number;
    role: LocalAiWorkerRole;
    policyId: string;
    progress: number;
}

export type LocalAiWorkerMessage = LocalAiWorkerResponse | LocalAiWorkerProgress;

export function parseLocalAiWorkerRequest(value: unknown): LocalAiWorkerRequest {
    if (!isRecord(value)
        || value.v !== LOCAL_AI_WORKER_PROTOCOL_VERSION
        || typeof value.requestId !== "string"
        || typeof value.jobId !== "string"
        || typeof value.workerEpoch !== "number"
        || !Number.isSafeInteger(value.workerEpoch)
        || value.workerEpoch < 1
        || !isRole(value.role)
        || typeof value.policyId !== "string"
        || !isOperation(value.operation)
        || !isRecord(value.payload)) {
        throw new Error("Invalid local AI worker request envelope.");
    }
    return value as unknown as LocalAiWorkerRequest;
}

export function parseLocalAiWorkerMessage(value: unknown): LocalAiWorkerMessage | null {
    if (!isRecord(value)
        || value.v !== LOCAL_AI_WORKER_PROTOCOL_VERSION
        || (value.type !== "response" && value.type !== "progress")
        || typeof value.requestId !== "string"
        || typeof value.jobId !== "string"
        || typeof value.workerEpoch !== "number"
        || !Number.isSafeInteger(value.workerEpoch)
        || value.workerEpoch < 1
        || !isRole(value.role)
        || typeof value.policyId !== "string") return null;
    if (value.type === "progress") {
        return typeof value.progress === "number" && Number.isFinite(value.progress)
            ? value as unknown as LocalAiWorkerProgress
            : null;
    }
    if (typeof value.ok !== "boolean") return null;
    if (!value.ok && (!isRecord(value.error)
        || typeof value.error.code !== "string"
        || typeof value.error.recoverable !== "boolean"
        || typeof value.error.safeMessage !== "string")) return null;
    return value as unknown as LocalAiWorkerResponse;
}

function isOperation(value: unknown): value is LocalAiWorkerOperation {
    return value === "prepare" || value === "embed" || value === "rerank" || value === "utility"
        || value === "cancel" || value === "clear" || value === "dispose";
}

function isRole(value: unknown): value is LocalAiWorkerRole {
    return value === "embedding" || value === "reranker" || value === "utility";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
