import type { RerankProvider, RerankRequest, RerankScore } from "../../domain/rerank/rerank-provider";
import type { RerankResultItem } from "../../domain/retrieval/retrieval-types";

export interface LegacyRerankClient {
    rerankDocuments(query: string, documents: string[]): Promise<RerankResultItem[]>;
}

/** 把旧服务的局部数组 index 转换为本次请求内的稳定候选 ID。 */
export class LegacyRerankAdapter implements RerankProvider {
    constructor(private readonly client: LegacyRerankClient) {}

    async rerank(request: RerankRequest): Promise<readonly RerankScore[]> {
        request.signal?.throwIfAborted();
        const results = await this.client.rerankDocuments(request.query, request.candidates.map((candidate) => candidate.text));
        request.signal?.throwIfAborted();
        const seen = new Set<number>();
        return results.flatMap((result) => {
            if (!Number.isInteger(result.index) || result.index < 0 || result.index >= request.candidates.length
                || !Number.isFinite(result.relevance_score) || seen.has(result.index)) return [];
            seen.add(result.index);
            const candidate = request.candidates[result.index];
            return candidate ? [{ candidateId: candidate.id, score: result.relevance_score }] : [];
        });
    }
}
