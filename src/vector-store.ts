import { normalizePath } from "obsidian";
import { VaultCoachPersistentStore } from "./persistent-store";
import type {
    VectorRecord,
    VectorSearchOptions,
    VectorStore,
    VectorStoreHit,
    VectorStoreStats,
} from "./types";

/**
 * 向量存储模块。
 *
 * 当前实现是嵌入式精确检索：所有向量加载到内存，搜索时逐条计算余弦相似度。
 * 这种方案实现简单、可离线运行，适合 Obsidian 插件的本地知识库规模；未来可通过 VectorStore 接口替换为 ANN 或外部向量库。
 */

/**
 * 写入 manifest 的轻量记录，只保存 chunkId 与元数据；真实向量写入二进制 shard。
 */
interface PersistedVectorRecord {
    chunkId: string;
    metadata: VectorRecord["metadata"];
}

/**
 * 向量索引 manifest。
 *
 * manifest 描述二进制分片的维度、记录顺序和统计信息，用于启动时恢复内存索引。
 */
interface EmbeddedVectorManifest {
    schemaVersion: number;
    backend: "embedded-exact";
    dimension: number | null;
    shardId: string;
    vectorCount: number;
    records: PersistedVectorRecord[];
    updatedAt: number | null;
    persistedBytes: number;
}

/**
 * 内存中的向量记录。
 */
interface StoredVectorRecord {
    chunkId: string;
    vector: Float32Array;
    metadata: VectorRecord["metadata"];
}

const VECTOR_MANIFEST_PATH = "vectors/manifest.json";
const VECTOR_SHARD_ID = "shard-000001.bin";
const VECTOR_SHARD_PATH = `vectors/${VECTOR_SHARD_ID}`;
const VECTOR_SCHEMA_VERSION = 1;

/**
 * 对向量做 L2 归一化。
 *
 * 存储和查询都归一化后，点积即可等价于余弦相似度。
 */
export function normalizeVector(source: ArrayLike<number>): Float32Array {
    let squaredNorm = 0;

    for (let index = 0; index < source.length; index += 1) {
        const value: number = source[index] ?? 0;
        squaredNorm += value * value;
    }

    const norm: number = Math.sqrt(squaredNorm);
    if (norm === 0) {
        return new Float32Array();
    }

    const result = new Float32Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
        result[index] = (source[index] ?? 0) / norm;
    }

    return result;
}

/**
 * 嵌入式精确向量存储。
 *
 * 负责向量的懒加载、增删改、topK 检索和磁盘持久化。
 */
export class EmbeddedExactVectorStore implements VectorStore {
    private readonly storage: VaultCoachPersistentStore;
    private readonly records: Map<string, StoredVectorRecord> = new Map<string, StoredVectorRecord>();
    private initialized = false;
    private dimension: number | null = null;
    private persistedBytes = 0;
    private loadedBytes = 0;
    private lastUpdatedAt: number | null = null;

    constructor(storage: VaultCoachPersistentStore) {
        this.storage = storage;
    }

    /**
     * 懒加载磁盘中的 manifest 和二进制分片。
     *
     * 如果发现版本、后端或分片长度不匹配，会清空内存状态以避免使用损坏索引。
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        const manifest: EmbeddedVectorManifest | null = await this.storage.loadKnowledgeIndexJson<EmbeddedVectorManifest>(VECTOR_MANIFEST_PATH);
        if (!manifest || manifest.schemaVersion !== VECTOR_SCHEMA_VERSION || manifest.backend !== "embedded-exact") {
            this.resetInMemoryState();
            return;
        }

        const shardBuffer: ArrayBuffer | null = await this.storage.loadKnowledgeIndexBinary(VECTOR_SHARD_PATH);
        if (!shardBuffer || !manifest.dimension || manifest.dimension <= 0) {
            this.resetInMemoryState();
            return;
        }

        const expectedFloatCount: number = manifest.records.length * manifest.dimension;
        const vectorData = new Float32Array(shardBuffer);
        if (vectorData.length < expectedFloatCount) {
            console.warn("[VaultCoach] Vector shard is shorter than manifest; clearing vector store.");
            await this.clear();
            return;
        }

        this.records.clear();
        for (let index = 0; index < manifest.records.length; index += 1) {
            const record: PersistedVectorRecord | undefined = manifest.records[index];
            if (!record) {
                continue;
            }

            const start: number = index * manifest.dimension;
            const end: number = start + manifest.dimension;
            this.records.set(record.chunkId, {
                chunkId: record.chunkId,
                vector: new Float32Array(vectorData.slice(start, end)),
                metadata: record.metadata,
            });
        }

        this.dimension = manifest.dimension;
        this.persistedBytes = manifest.persistedBytes;
        this.loadedBytes = this.records.size * manifest.dimension * Float32Array.BYTES_PER_ELEMENT;
        this.lastUpdatedAt = manifest.updatedAt;
    }

    /**
     * 插入或更新一批向量记录。
     *
     * 所有向量必须和现有索引维度一致；维度不一致的记录会被跳过。
     */
    async upsert(records: VectorRecord[]): Promise<void> {
        await this.initialize();

        let changed = false;
        for (const record of records) {
            const normalizedVector: Float32Array = normalizeVector(record.vector);
            if (normalizedVector.length === 0) {
                continue;
            }

            if (this.dimension !== null && normalizedVector.length !== this.dimension) {
                console.warn("[VaultCoach] Skip vector with incompatible dimension", record.chunkId);
                continue;
            }

            this.dimension = normalizedVector.length;
            this.records.set(record.chunkId, {
                chunkId: record.chunkId,
                vector: normalizedVector,
                metadata: { ...record.metadata },
            });
            changed = true;
        }

        if (changed) {
            await this.persist();
        }
    }

    /**
     * 根据 chunkId 删除向量。
     */
    async remove(chunkIds: string[]): Promise<void> {
        await this.initialize();

        let changed = false;
        for (const chunkId of chunkIds) {
            if (this.records.delete(chunkId)) {
                changed = true;
            }
        }

        if (changed) {
            await this.persist();
        }
    }

    /**
     * 对查询向量执行精确 topK 搜索。
     *
     * 使用小顶堆保留当前最强的 K 个命中，避免先收集全部结果再排序造成额外内存开销。
     */
    async search(queryVector: Float32Array, options: VectorSearchOptions): Promise<VectorStoreHit[]> {
        await this.initialize();

        const normalizedQuery: Float32Array = normalizeVector(queryVector);
        if (normalizedQuery.length === 0 || this.records.size === 0) {
            return [];
        }

        const topK: number = Math.max(1, Math.floor(options.topK));
        const heap: VectorStoreHit[] = [];

        for (const record of this.records.values()) {
            if (!this.matchesFilter(record, options)) {
                continue;
            }

            const similarity: number = this.dot(normalizedQuery, record.vector);
            const hit: VectorStoreHit = {
                chunkId: record.chunkId,
                score: similarity,
                similarity,
            };
            this.pushTopK(heap, hit, topK);
        }

        return heap.sort((left: VectorStoreHit, right: VectorStoreHit) => right.score - left.score);
    }

    /**
     * 清空内存和磁盘中的向量索引。
     */
    async clear(): Promise<void> {
        this.resetInMemoryState();
        this.initialized = true;
        await this.storage.removeKnowledgeIndexPath(VECTOR_MANIFEST_PATH);
        await this.storage.removeKnowledgeIndexPath(VECTOR_SHARD_PATH);
    }

    /**
     * 返回当前向量索引统计信息。
     */
    async getStats(): Promise<VectorStoreStats> {
        await this.initialize();
        return {
            backend: "embedded-exact",
            vectorCount: this.records.size,
            dimension: this.dimension,
            persistedBytes: this.persistedBytes,
            loadedBytes: this.loadedBytes,
            lastUpdatedAt: this.lastUpdatedAt,
        };
    }

    /**
     * 释放内存状态。
     */
    async close(): Promise<void> {
        this.records.clear();
        this.initialized = false;
        this.dimension = null;
        this.loadedBytes = 0;
    }

    /**
     * 将当前内存索引写入 manifest + 二进制 shard。
     */
    private async persist(): Promise<void> {
        const sortedRecords: StoredVectorRecord[] = Array.from(this.records.values())
            .sort((left: StoredVectorRecord, right: StoredVectorRecord) => left.chunkId.localeCompare(right.chunkId));
        const dimension: number | null = this.dimension;

        if (!dimension || sortedRecords.length === 0) {
            await this.clear();
            return;
        }

        const vectorData = new Float32Array(sortedRecords.length * dimension);
        for (let index = 0; index < sortedRecords.length; index += 1) {
            const record: StoredVectorRecord | undefined = sortedRecords[index];
            if (!record) {
                continue;
            }
            vectorData.set(record.vector, index * dimension);
        }

        const shardBuffer: ArrayBuffer = vectorData.buffer.slice(
            vectorData.byteOffset,
            vectorData.byteOffset + vectorData.byteLength,
        );
        const updatedAt: number = Date.now();
        const manifest: EmbeddedVectorManifest = {
            schemaVersion: VECTOR_SCHEMA_VERSION,
            backend: "embedded-exact",
            dimension,
            shardId: VECTOR_SHARD_ID,
            vectorCount: sortedRecords.length,
            records: sortedRecords.map((record: StoredVectorRecord) => ({
                chunkId: record.chunkId,
                metadata: { ...record.metadata },
            })),
            updatedAt,
            persistedBytes: shardBuffer.byteLength,
        };

        await this.storage.saveKnowledgeIndexBinary(VECTOR_SHARD_PATH, shardBuffer);
        await this.storage.saveKnowledgeIndexJson(VECTOR_MANIFEST_PATH, manifest);

        this.persistedBytes = shardBuffer.byteLength;
        this.loadedBytes = shardBuffer.byteLength;
        this.lastUpdatedAt = updatedAt;
    }

    /**
     * 清理所有内存态字段。
     */
    private resetInMemoryState(): void {
        this.records.clear();
        this.dimension = null;
        this.persistedBytes = 0;
        this.loadedBytes = 0;
        this.lastUpdatedAt = null;
    }

    /**
     * 判断记录是否满足调用方指定的文档/目录过滤条件。
     */
    private matchesFilter(record: StoredVectorRecord, options: VectorSearchOptions): boolean {
        const filter = options.filter;
        if (!filter) {
            return true;
        }

        if (filter.documentIds && !filter.documentIds.includes(record.metadata.documentId)) {
            return false;
        }

        if (filter.documentTypes && !filter.documentTypes.includes(record.metadata.documentType)) {
            return false;
        }

        if (filter.folderPaths && filter.folderPaths.length > 0) {
            const filePath: string = normalizePath(record.metadata.filePath ?? "");
            if (!filter.folderPaths.some((folderPath: string) => this.isFileInFolder(filePath, folderPath))) {
                return false;
            }
        }

        return true;
    }

    /**
     * 判断文件路径是否位于指定目录内。
     */
    private isFileInFolder(filePath: string, folderPath: string): boolean {
        const normalizedFolderPath: string = normalizePath(folderPath.trim()).replace(/\/$/, "");
        if (normalizedFolderPath.length === 0) {
            return true;
        }

        return filePath === normalizedFolderPath || filePath.startsWith(`${normalizedFolderPath}/`);
    }

    /**
     * 将命中写入 topK 小顶堆。
     */
    private pushTopK(heap: VectorStoreHit[], hit: VectorStoreHit, topK: number): void {
        if (heap.length < topK) {
            heap.push(hit);
            this.siftUp(heap, heap.length - 1);
            return;
        }

        const weakestHit: VectorStoreHit | undefined = heap[0];
        if (!weakestHit || hit.score <= weakestHit.score) {
            return;
        }

        heap[0] = hit;
        this.siftDown(heap, 0);
    }

    /**
     * 小顶堆上浮操作。
     */
    private siftUp(heap: VectorStoreHit[], index: number): void {
        let childIndex = index;
        while (childIndex > 0) {
            const parentIndex: number = Math.floor((childIndex - 1) / 2);
            if ((heap[parentIndex]?.score ?? Number.NEGATIVE_INFINITY) <= (heap[childIndex]?.score ?? Number.NEGATIVE_INFINITY)) {
                break;
            }

            this.swap(heap, parentIndex, childIndex);
            childIndex = parentIndex;
        }
    }

    /**
     * 小顶堆下沉操作。
     */
    private siftDown(heap: VectorStoreHit[], index: number): void {
        let parentIndex = index;
        while (true) {
            const leftIndex: number = parentIndex * 2 + 1;
            const rightIndex: number = leftIndex + 1;
            let smallestIndex: number = parentIndex;

            if ((heap[leftIndex]?.score ?? Number.POSITIVE_INFINITY) < (heap[smallestIndex]?.score ?? Number.POSITIVE_INFINITY)) {
                smallestIndex = leftIndex;
            }

            if ((heap[rightIndex]?.score ?? Number.POSITIVE_INFINITY) < (heap[smallestIndex]?.score ?? Number.POSITIVE_INFINITY)) {
                smallestIndex = rightIndex;
            }

            if (smallestIndex === parentIndex) {
                break;
            }

            this.swap(heap, parentIndex, smallestIndex);
            parentIndex = smallestIndex;
        }
    }

    /**
     * 交换堆中的两个命中。
     */
    private swap(heap: VectorStoreHit[], leftIndex: number, rightIndex: number): void {
        const left: VectorStoreHit | undefined = heap[leftIndex];
        const right: VectorStoreHit | undefined = heap[rightIndex];
        if (!left || !right) {
            return;
        }

        heap[leftIndex] = right;
        heap[rightIndex] = left;
    }

    /**
     * 计算两个已归一化向量的点积。
     */
    private dot(left: Float32Array, right: Float32Array): number {
        const length: number = Math.min(left.length, right.length);
        let score = 0;
        for (let index = 0; index < length; index += 1) {
            score += (left[index] ?? 0) * (right[index] ?? 0);
        }
        return score;
    }
}
