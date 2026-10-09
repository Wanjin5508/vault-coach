import { normalizeVector } from "../../vector-store";

export interface ConceptEmbeddingRecord {
    conceptId: string;
    vector: number[];
}

export interface ConceptSimilarityHit {
    conceptId: string;
    similarity: number;
}

/**
 * 仅面向 Concept 的相似度端口。
 *
 * 该端口与 RAG chunk 存储分离，因为语义概念只允许有界近邻查询，
 * 不能执行不受限制的全量两两比较。
 */
export interface ConceptSimilarityIndex {
    upsert(items: readonly ConceptEmbeddingRecord[]): Promise<void>;
    remove(conceptIds: readonly string[]): Promise<void>;
    findNearest(vector: readonly number[], limit: number): Promise<ConceptSimilarityHit[]>;
    rebuild(items: readonly ConceptEmbeddingRecord[]): Promise<void>;
    clear(): Promise<void>;
}

interface IndexedConceptVector {
    conceptId: string;
    vector: Float32Array;
    bucketKeys: string[];
}

/**
 * 浏览器安全的局部敏感哈希索引。
 *
 * 这是近似最近邻实现：每次查询只对少量确定性签名桶中的记录评分。
 * 空桶直接返回无结果，不提供精确全索引扫描作为降级路径。
 */
export class BoundedLshConceptSimilarityIndex implements ConceptSimilarityIndex {
    private readonly records = new Map<string, IndexedConceptVector>();
    private readonly buckets = new Map<string, Set<string>>();

    async upsert(items: readonly ConceptEmbeddingRecord[]): Promise<void> {
        for (const item of items) {
            const vector = normalizeVector(item.vector);
            if (vector.length === 0) continue;
            const previous = this.records.get(item.conceptId);
            if (previous) this.removeFromBuckets(previous);
            const indexed: IndexedConceptVector = {
                conceptId: item.conceptId,
                vector,
                bucketKeys: this.createBucketKeys(vector),
            };
            this.records.set(item.conceptId, indexed);
            for (const key of indexed.bucketKeys) {
                const bucket = this.buckets.get(key) ?? new Set<string>();
                bucket.add(indexed.conceptId);
                this.buckets.set(key, bucket);
            }
        }
    }

    async remove(conceptIds: readonly string[]): Promise<void> {
        for (const conceptId of conceptIds) {
            const previous = this.records.get(conceptId);
            if (!previous) continue;
            this.removeFromBuckets(previous);
            this.records.delete(conceptId);
        }
    }

    async findNearest(vector: readonly number[], limit: number): Promise<ConceptSimilarityHit[]> {
        const normalized = normalizeVector(vector);
        if (normalized.length === 0 || limit <= 0) return [];
        const candidateIds = new Set<string>();
        for (const bucketKey of this.createBucketKeys(normalized)) {
            for (const conceptId of this.buckets.get(bucketKey) ?? []) {
                candidateIds.add(conceptId);
                // 硬上限防止异常公共桶退化为意外的全索引扫描。
                if (candidateIds.size >= 512) break;
            }
            if (candidateIds.size >= 512) break;
        }
        return Array.from(candidateIds)
            .map((conceptId): ConceptSimilarityHit | null => {
                const record = this.records.get(conceptId);
                if (!record || record.vector.length !== normalized.length) return null;
                return { conceptId, similarity: dot(normalized, record.vector) };
            })
            .filter((hit): hit is ConceptSimilarityHit => hit !== null)
            .sort((left, right) => right.similarity - left.similarity || left.conceptId.localeCompare(right.conceptId))
            .slice(0, Math.max(1, Math.min(50, Math.floor(limit))));
    }

    async rebuild(items: readonly ConceptEmbeddingRecord[]): Promise<void> {
        await this.clear();
        await this.upsert(items);
    }

    async clear(): Promise<void> {
        this.records.clear();
        this.buckets.clear();
    }

    private removeFromBuckets(record: IndexedConceptVector): void {
        for (const key of record.bucketKeys) {
            const bucket = this.buckets.get(key);
            if (!bucket) continue;
            bucket.delete(record.conceptId);
            if (bucket.size === 0) this.buckets.delete(key);
        }
    }

    private createBucketKeys(vector: Float32Array): string[] {
        const tableCount = 4;
        const bitsPerTable = 12;
        const keys: string[] = [];
        for (let table = 0; table < tableCount; table += 1) {
            let signature = "";
            for (let bit = 0; bit < bitsPerTable; bit += 1) {
                const dimension = ((table + 1) * 131 + (bit + 17) * 67) % vector.length;
                const alternate = ((table + 11) * 43 + (bit + 3) * 29) % vector.length;
                const sign = ((table + bit) & 1) === 0 ? 1 : -1;
                signature += ((vector[dimension] ?? 0) + sign * (vector[alternate] ?? 0) >= 0) ? "1" : "0";
            }
            keys.push(`${table}:${signature}`);
        }
        return keys;
    }
}

function dot(left: Float32Array, right: Float32Array): number {
    let total = 0;
    for (let index = 0; index < left.length; index += 1) total += (left[index] ?? 0) * (right[index] ?? 0);
    return total;
}
