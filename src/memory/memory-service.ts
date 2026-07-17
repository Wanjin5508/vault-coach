import type { AdvancedRagEngine } from "../rag-engine";
import type { ChatMessage, MemoryItem, MemorySearchHit, VaultCoachSettings } from "../types";

/**
 * 管理长期记忆的本地状态、检索、抽取、去重和裁剪。
 *
 * 该服务不负责持久化；主插件在会话状态保存/恢复时注入或读取快照。
 */
export class LongTermMemoryService {
    private memories: MemoryItem[] = [];

    constructor(
        private readonly getSettings: () => VaultCoachSettings,
        private readonly getMessages: () => ChatMessage[],
        private readonly ragEngine: AdvancedRagEngine,
    ) {}

    hydrate(memories: MemoryItem[]): void {
        this.memories = [...memories];
        this.trim();
    }

    getAll(): MemoryItem[] {
        return [...this.memories];
    }

    getCount(): number {
        return this.memories.length;
    }

    buildContext(query: string): string {
        const settings: VaultCoachSettings = this.getSettings();
        if (!settings.enableLongTermMemory || this.memories.length === 0) {
            return "";
        }

        const hits: MemorySearchHit[] = this.search(query, settings.memoryTopK);
        if (hits.length === 0) {
            return "";
        }

        const now: number = Date.now();
        for (const hit of hits) {
            hit.item.lastAccessedAt = now;
        }

        return hits
            .map((hit: MemorySearchHit, index: number) => `${index + 1}. ${hit.item.text}`)
            .join("\n");
    }

    async updateFromAssistantTurn(userText: string, assistantText: string): Promise<void> {
        const settings: VaultCoachSettings = this.getSettings();
        if (!settings.enableLongTermMemory) {
            return;
        }

        const memoryStatements: string[] = await this.ragEngine.extractMemoryStatements(
            userText,
            assistantText,
            this.getMessages(),
        );

        if (memoryStatements.length === 0) {
            return;
        }

        const now: number = Date.now();
        for (const statement of memoryStatements) {
            const normalizedStatement: string = this.normalizeText(statement);
            if (normalizedStatement.length === 0) {
                continue;
            }

            const existing: MemoryItem | undefined = this.memories.find((item: MemoryItem) => {
                return this.normalizeText(item.text) === normalizedStatement;
            });

            if (existing) {
                existing.text = statement.trim();
                existing.updatedAt = now;
                existing.lastAccessedAt = now;
                continue;
            }

            this.memories.unshift({
                id: this.createId(normalizedStatement),
                text: statement.trim(),
                createdAt: now,
                updatedAt: now,
                lastAccessedAt: now,
            });
        }

        this.trim();
    }

    trim(): void {
        const maxItems: number = Math.max(1, this.getSettings().memoryMaxItems);
        if (this.memories.length <= maxItems) {
            return;
        }

        this.memories.sort((left: MemoryItem, right: MemoryItem) => {
            const rightKey: number = Math.max(right.updatedAt, right.lastAccessedAt);
            const leftKey: number = Math.max(left.updatedAt, left.lastAccessedAt);
            return rightKey - leftKey;
        });

        this.memories = this.memories.slice(0, maxItems);
    }

    private search(query: string, limit: number): MemorySearchHit[] {
        const normalizedQuery: string = this.normalizeText(query);
        const queryTokens: string[] = Array.from(new Set(this.tokenize(query)));
        const hits: MemorySearchHit[] = [];

        for (const item of this.memories) {
            const normalizedText: string = this.normalizeText(item.text);
            const memoryTokens: Set<string> = new Set(this.tokenize(item.text));

            let score = 0;
            let overlapCount = 0;

            if (normalizedQuery.length > 0 && normalizedText.includes(normalizedQuery)) {
                score += 3;
            }

            for (const token of queryTokens) {
                if (memoryTokens.has(token)) {
                    overlapCount += 1;
                }
            }

            if (overlapCount === 0 && score === 0) {
                continue;
            }

            score += overlapCount * 0.6;
            score += Math.max(0, (item.updatedAt - (Date.now() - 1000 * 60 * 60 * 24 * 30)) / (1000 * 60 * 60 * 24 * 30));

            hits.push({
                item,
                score,
                matchedTokens: queryTokens.filter((token: string) => memoryTokens.has(token)),
            });
        }

        hits.sort((left: MemorySearchHit, right: MemorySearchHit) => right.score - left.score);
        return hits.slice(0, limit);
    }

    private normalizeText(text: string): string {
        return text.toLowerCase().replace(/\s+/g, " ").trim();
    }

    private tokenize(text: string): string[] {
        const normalizedText: string = text.toLowerCase();
        const tokens: string[] = [];

        const latinMatches: RegExpMatchArray | null = normalizedText.match(/[a-z0-9_./-]+/g);
        if (latinMatches) {
            for (const token of latinMatches) {
                if (token.trim().length > 0) {
                    tokens.push(token.trim());
                }
            }
        }

        const chineseSequences: RegExpMatchArray | null = normalizedText.match(/[\u4e00-\u9fff]+/g);
        if (chineseSequences) {
            for (const sequence of chineseSequences) {
                for (const char of sequence) {
                    tokens.push(char);
                }

                for (let index = 0; index < sequence.length - 1; index += 1) {
                    tokens.push(sequence.slice(index, index + 2));
                }
            }
        }

        return tokens;
    }

    private createId(text: string): string {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `mem_${(hash >>> 0).toString(16)}`;
    }
}
