/**
 * 插件到 Engine 的协议元数据。
 *
 * 这些类型不得包含传输实现、凭据、Vault 内容或 Obsidian API。
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

/** 未来 Local 客户端使用能力前，必须先完成显式能力协商。 */
export type KnowledgeEngineCapability =
    | "revisioned-sync"
    | "bounded-retrieval"
    | "bounded-graph-projection"
    | "durable-jobs"
    | "knowledge-profile";

/** 一次能力协商的结果；不可用状态必须提供机器可判定的 `reason`。 */
export interface KnowledgeEngineAvailability {
    mode: KnowledgeEngineMode;
    status: KnowledgeEngineAvailabilityStatus;
    protocolVersion: typeof KNOWLEDGE_ENGINE_PROTOCOL_VERSION;
    capabilities: readonly KnowledgeEngineCapability[];
    reason: KnowledgeEngineAvailabilityReason;
    /** 供日志和设置页使用的可读诊断信息，不得作为最终用户本地化 key。 */
    detail: string;
}

/** 设置页和诊断日志使用的运行信息，不得包含凭据或 Vault 内容。 */
export interface KnowledgeEngineDiagnostics {
    endpoint: string | null;
    lastCheckedAt: number | null;
    lastError: string | null;
    networkRequestsMade: number;
    /** 描述当前客户端实现必须满足的隐私不变量。 */
    dataTransfer: "none" | "explicit-user-authorized";
}

/**
 * 可选 Knowledge Engine 的最小客户端端口。
 * 实现必须先报告能力再提供增强功能，并保持 Lite 主流程独立可用。
 */
export interface KnowledgeEngineClient {
    getAvailability(): KnowledgeEngineAvailability;
    getDiagnostics(): KnowledgeEngineDiagnostics;
    /**
     * 未来 Local 客户端可在此刷新健康状态并重新协商版本。
     * Lite 实现必须立即完成，且不得发起任何网络请求。
     */
    refresh(signal?: AbortSignal): Promise<KnowledgeEngineAvailability>;
}
