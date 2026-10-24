export interface MemoryExtractionRequest {
    conversationContext: string;
    latestUserText: string;
    latestAssistantText: string;
}

export interface MemoryExtractionPort {
    extractMemoryStatements(request: MemoryExtractionRequest): Promise<readonly string[]>;
}
