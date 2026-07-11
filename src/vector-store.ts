import { normalizePath } from "obsidian";
import { VaultCoachPersistentStore } from "./persistent-store";
import type {
    VectorRecord,
    VectorSearchOptions,
    VectorStore,
    VectorStoreHit,
    VectorStoreStats,
} from "./types";

interface PersistedVectorRecord {
    chunkId: string;
    metadata: VectorRecord["metadata"];
}

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

interface StoredVectorRecord {
    chunkId: string;
    vector: Float32Array;
    metadata: VectorRecord["metadata"];
}

const VECTOR_MANIFEST_PATH = "vectors/manifest.json";
const VECTOR_SHARD_ID = "shard-000001.bin";
const VECTOR_SHARD_PATH = `vectors/${VECTOR_SHARD_ID}`;
const VECTOR_SCHEMA_VERSION = 1;

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

    async clear(): Promise<void> {
        this.resetInMemoryState();
        this.initialized = true;
        await this.storage.removeKnowledgeIndexPath(VECTOR_MANIFEST_PATH);
        await this.storage.removeKnowledgeIndexPath(VECTOR_SHARD_PATH);
    }

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

    async close(): Promise<void> {
        this.records.clear();
        this.initialized = false;
        this.dimension = null;
        this.loadedBytes = 0;
    }

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

    private resetInMemoryState(): void {
        this.records.clear();
        this.dimension = null;
        this.persistedBytes = 0;
        this.loadedBytes = 0;
        this.lastUpdatedAt = null;
    }

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

    private isFileInFolder(filePath: string, folderPath: string): boolean {
        const normalizedFolderPath: string = normalizePath(folderPath.trim()).replace(/\/$/, "");
        if (normalizedFolderPath.length === 0) {
            return true;
        }

        return filePath === normalizedFolderPath || filePath.startsWith(`${normalizedFolderPath}/`);
    }

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

    private swap(heap: VectorStoreHit[], leftIndex: number, rightIndex: number): void {
        const left: VectorStoreHit | undefined = heap[leftIndex];
        const right: VectorStoreHit | undefined = heap[rightIndex];
        if (!left || !right) {
            return;
        }

        heap[leftIndex] = right;
        heap[rightIndex] = left;
    }

    private dot(left: Float32Array, right: Float32Array): number {
        const length: number = Math.min(left.length, right.length);
        let score = 0;
        for (let index = 0; index < length; index += 1) {
            score += (left[index] ?? 0) * (right[index] ?? 0);
        }
        return score;
    }
}
