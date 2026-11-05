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

/** Provider batch 内的候选 ID 必须稳定且唯一，避免局部 index 或重复 ID 造成引用错位。 */
export function assertValidRerankRequest(request: RerankRequest): void {
    const candidateIds = new Set<string>();
    for (const candidate of request.candidates) {
        if (candidate.id.length === 0) throw new Error("Rerank candidate ID must not be empty.");
        if (candidateIds.has(candidate.id)) throw new Error(`Duplicate rerank candidate ID: ${candidate.id}`);
        candidateIds.add(candidate.id);
    }
}

/** M6.1 将在此端口后增加内置 cross-encoder；M3 只保留现有远程行为。 */
export interface RerankProvider {
    rerank(request: RerankRequest): Promise<readonly RerankScore[]>;
}
