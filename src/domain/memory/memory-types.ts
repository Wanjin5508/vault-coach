export interface MemoryItem {
    id: string;
    text: string;
    createdAt: number;
    updatedAt: number;
    lastAccessedAt: number;
}

export interface MemorySearchHit {
    item: MemoryItem;
    score: number;
    matchedTokens: string[];
}
