export interface RerankCandidateInput {
    id: string;
    text: string;
}

export interface RerankRequest {
    query: string;
    candidates: readonly RerankCandidateInput[];
    signal?: AbortSignal;
}

export interface RerankScore {
    candidateId: string;
    score: number;
}

/** M6.1 将在此端口后增加内置 cross-encoder；M3 只保留现有远程行为。 */
export interface RerankProvider {
    rerank(request: RerankRequest): Promise<readonly RerankScore[]>;
}
