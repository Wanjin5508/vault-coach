import {
    KNOWLEDGE_ENGINE_PROTOCOL_VERSION,
    type KnowledgeEngineAvailability,
    type KnowledgeEngineClient,
    type KnowledgeEngineDiagnostics,
} from "./knowledge-engine-types";

/**
 * Default Engine port implementation. It documents that Lite is already a
 * working local engine path, while guaranteeing no socket, fetch, Docker, or
 * background process is touched before a user deliberately enables Local.
 */
export class LiteEngineClient implements KnowledgeEngineClient {
    getAvailability(): KnowledgeEngineAvailability {
        return {
            mode: "lite",
            status: "available",
            protocolVersion: KNOWLEDGE_ENGINE_PROTOCOL_VERSION,
            capabilities: [],
            reason: "lite-default",
            detail: "Vault Coach Lite is active; no Knowledge Engine service is configured.",
        };
    }

    getDiagnostics(): KnowledgeEngineDiagnostics {
        return {
            endpoint: null,
            lastCheckedAt: null,
            lastError: null,
            networkRequestsMade: 0,
            dataTransfer: "none",
        };
    }

    async refresh(signal?: AbortSignal): Promise<KnowledgeEngineAvailability> {
        signal?.throwIfAborted();
        return this.getAvailability();
    }
}
