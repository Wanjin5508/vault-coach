/**
 * Plugin-to-Engine protocol metadata. These types deliberately contain no
 * transport implementation, credential, Vault content, or Obsidian API.
 */
export const KNOWLEDGE_ENGINE_PROTOCOL_VERSION = 1 as const;

export type KnowledgeEngineMode = "lite" | "local";
export type KnowledgeEngineAvailabilityStatus = "available" | "unavailable";
export type KnowledgeEngineAvailabilityReason =
    | "lite-default"
    | "not-configured"
    | "not-installed"
    | "connection-failed"
    | "protocol-incompatible"
    | "authentication-failed"
    | "service-busy";

/** Capabilities are negotiated explicitly before a future Local client uses them. */
export type KnowledgeEngineCapability =
    | "revisioned-sync"
    | "bounded-retrieval"
    | "bounded-graph-projection"
    | "durable-jobs"
    | "knowledge-profile";

export interface KnowledgeEngineAvailability {
    mode: KnowledgeEngineMode;
    status: KnowledgeEngineAvailabilityStatus;
    protocolVersion: typeof KNOWLEDGE_ENGINE_PROTOCOL_VERSION;
    capabilities: readonly KnowledgeEngineCapability[];
    reason: KnowledgeEngineAvailabilityReason;
    /** Human-readable diagnostics for logs/settings, never an end-user localisation key. */
    detail: string;
}

export interface KnowledgeEngineDiagnostics {
    endpoint: string | null;
    lastCheckedAt: number | null;
    lastError: string | null;
    networkRequestsMade: number;
    /** States the privacy invariant of the active client implementation. */
    dataTransfer: "none" | "explicit-user-authorized";
}

export interface KnowledgeEngineClient {
    getAvailability(): KnowledgeEngineAvailability;
    getDiagnostics(): KnowledgeEngineDiagnostics;
    /**
     * Future Local clients can refresh health/version negotiation here. Lite
     * completes immediately and must never perform a network request.
     */
    refresh(signal?: AbortSignal): Promise<KnowledgeEngineAvailability>;
}
