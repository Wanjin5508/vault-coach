import {
    KNOWLEDGE_ENGINE_PROTOCOL_VERSION,
    type KnowledgeEngineAvailability,
    type KnowledgeEngineClient,
    type KnowledgeEngineDiagnostics,
} from "./knowledge-engine-types";

/**
 * Engine 端口的默认实现。
 *
 * Lite 本身是可工作的本地执行路径；在用户主动启用 Local 前，不得访问 socket、fetch、
 * Docker 或任何后台进程。
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
