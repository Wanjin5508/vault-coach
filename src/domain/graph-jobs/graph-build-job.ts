import type { GraphRename } from "../graph/graph-types";

export const GRAPH_BUILD_JOB_SCHEMA_VERSION = 1 as const;

export type GraphBuildJobPhase =
    | "queued"
    | "snapshotting"
    | "structural"
    | "extracting"
    | "concept-embedding"
    | "candidate-building"
    | "validating"
    | "graph-ready"
    | "stale"
    | "failed"
    | "cancelled"
    | "superseded";

export interface GraphBuildCheckpoint {
    processedSections: number;
    failedSections: number;
    queuedSections: number;
}

export interface GraphBuildJob {
    schemaVersion: typeof GRAPH_BUILD_JOB_SCHEMA_VERSION;
    jobId: string;
    sourceCoreGenerationId: string;
    graphPolicyId: string;
    mode: "full" | "incremental";
    phase: GraphBuildJobPhase;
    affectedFiles: string[];
    renames: GraphRename[];
    reconcileSemanticSources: boolean;
    checkpoint: GraphBuildCheckpoint;
    createdAt: number;
    updatedAt: number;
    errorCode: string | null;
}

export function isGraphBuildJob(value: unknown): value is GraphBuildJob {
    if (!isRecord(value) || !isRecord(value.checkpoint)) return false;
    return value.schemaVersion === GRAPH_BUILD_JOB_SCHEMA_VERSION
        && typeof value.jobId === "string"
        && typeof value.sourceCoreGenerationId === "string"
        && typeof value.graphPolicyId === "string"
        && (value.mode === "full" || value.mode === "incremental")
        && isGraphBuildJobPhase(value.phase)
        && Array.isArray(value.affectedFiles) && value.affectedFiles.every((path) => typeof path === "string")
        && Array.isArray(value.renames) && value.renames.every(isRename)
        && typeof value.reconcileSemanticSources === "boolean"
        && isCount(value.checkpoint.processedSections)
        && isCount(value.checkpoint.failedSections)
        && isCount(value.checkpoint.queuedSections)
        && isCount(value.createdAt)
        && isCount(value.updatedAt)
        && (value.errorCode === null || typeof value.errorCode === "string");
}

export function isGraphBuildJobTerminal(phase: GraphBuildJobPhase): boolean {
    return phase === "graph-ready" || phase === "stale" || phase === "failed"
        || phase === "cancelled" || phase === "superseded";
}

function isGraphBuildJobPhase(value: unknown): value is GraphBuildJobPhase {
    return value === "queued" || value === "snapshotting" || value === "structural" || value === "extracting"
        || value === "concept-embedding" || value === "candidate-building" || value === "validating"
        || value === "graph-ready" || value === "stale" || value === "failed"
        || value === "cancelled" || value === "superseded";
}

function isRename(value: unknown): value is GraphRename {
    return isRecord(value) && typeof value.oldPath === "string" && typeof value.newPath === "string";
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
