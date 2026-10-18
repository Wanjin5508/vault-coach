import type {
    RetrievalPreference,
    RetrievalResolution,
} from "../../domain/retrieval/retrieval-types";

export interface RetrievalCapabilitySnapshot {
    vectorEnabled: boolean;
    vectorReady: boolean;
}

/**
 * 将用户偏好解析为本次请求实际使用的检索模式。
 *
 * 该函数无副作用，便于设置页、RAG 管线和诊断界面共享同一套判定规则。
 * 向量能力不可用时统一回退关键词，避免新安装用户在首次建索引前无法提问。
 */
export function resolveRetrievalMode(
    preference: RetrievalPreference,
    capability: RetrievalCapabilitySnapshot,
): RetrievalResolution {
    if (preference === "keyword") {
        return { preference, resolvedMode: "keyword", reason: "explicit" };
    }

    if (!capability.vectorEnabled || !capability.vectorReady) {
        return { preference, resolvedMode: "keyword", reason: "vector-unavailable" };
    }

    if (preference === "auto") {
        return { preference, resolvedMode: "hybrid", reason: "vector-ready" };
    }

    return { preference, resolvedMode: preference, reason: "explicit" };
}

/** 向量调用失败后的统一降级结果。 */
export function resolveVectorFailure(preference: RetrievalPreference): RetrievalResolution {
    return { preference, resolvedMode: "keyword", reason: "vector-failed" };
}
