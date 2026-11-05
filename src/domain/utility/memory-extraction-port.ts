export interface MemoryExtractionRequest {
    conversationContext: string;
    latestUserText: string;
    latestAssistantText: string;
    signal?: AbortSignal;
}

export interface MemoryExtractionPort {
    extractMemoryStatements(request: MemoryExtractionRequest): Promise<readonly string[]>;
}
