import type { LocalAIRerankerRuntimePort } from "../../domain/local-ai/local-ai-types";
import {
    assertValidRerankRequest,
    type RerankProvider,
    type RerankRequest,
    type RerankScore,
} from "../../domain/rerank/rerank-provider";

/** 将共享 LocalAIRuntime 的 bounded cross-encoder 任务适配为 RAG 的稳定候选 ID 端口。 */
export class BuiltinRerankProvider implements RerankProvider {
    constructor(private readonly runtime: LocalAIRerankerRuntimePort) {}

    async rerank(request: RerankRequest): Promise<readonly RerankScore[]> {
        assertValidRerankRequest(request);
        if (request.candidates.length === 0) return [];
        const result = await this.runtime.rerank({
            query: request.query,
            candidates: request.candidates.map((candidate) => ({ ...candidate })),
            signal: request.signal,
        });
        return result.scores;
    }
}
