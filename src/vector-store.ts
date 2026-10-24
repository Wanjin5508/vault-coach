import { normalizePath } from "obsidian";
import { VaultCoachPersistentStore } from "./persistent-store";
import { areEmbeddingFingerprintsEqual, validateEmbeddingFingerprint } from "./domain/embedding/embedding-fingerprint";
import { EmbeddingError } from "./domain/embedding/embedding-error";
import type { EmbeddingFingerprint } from "./domain/embedding/embedding-provider";
import type { VectorRecord, VectorSearchOptions, VectorStore, VectorStoreHit, VectorStoreInspection, VectorStoreStats } from "./domain/retrieval/retrieval-types";

interface PersistedVectorRecord { chunkId: string; metadata: VectorRecord["metadata"]; }
interface VectorGenerationPointer { schemaVersion: 1; generationId: string; }
interface EmbeddedVectorManifestV2 {
    schemaVersion: 2;
    backend: "embedded-exact";
    generationId: string;
    fingerprint: EmbeddingFingerprint;
    dimension: number;
    shardId: string;
    shardByteLength: number;
    vectorCount: number;
    records: PersistedVectorRecord[];
    updatedAt: number;
    persistedBytes: number;
}
interface StoredVectorRecord { chunkId: string; vector: Float32Array; metadata: VectorRecord["metadata"]; }
interface LoadedGeneration { manifest: EmbeddedVectorManifestV2; records: Map<string, StoredVectorRecord>; }

const VECTOR_ROOT = "vectors";
const ACTIVE_POINTER_PATH = `${VECTOR_ROOT}/active.json`;
const NEXT_POINTER_PATH = `${VECTOR_ROOT}/active.json.next`;
const BACKUP_POINTER_PATH = `${VECTOR_ROOT}/active.json.bak`;
const LEGACY_MANIFEST_PATH = `${VECTOR_ROOT}/manifest.json`;

/** 存储和查询统一做 L2 归一化，使点积等价于余弦相似度。 */
export function normalizeVector(source: ArrayLike<number>): Float32Array {
    let squaredNorm = 0;
    for (let index = 0; index < source.length; index += 1) {
        const value = source[index] ?? 0;
        if (!Number.isFinite(value)) return new Float32Array();
        squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm === 0) return new Float32Array();
    const result = new Float32Array(source.length);
    for (let index = 0; index < source.length; index += 1) result[index] = (source[index] ?? 0) / norm;
    return result;
}

/**
 * 嵌入式精确向量存储。新内容先写入不可变 generation，校验通过后才切换 active 指针。
 * `.bak` 保留上一个可读指针，因此构建失败不会破坏现有索引。
 */
export class EmbeddedExactVectorStore implements VectorStore {
    private readonly records = new Map<string, StoredVectorRecord>();
    private initialized = false;
    private fingerprint: EmbeddingFingerprint | null = null;
    private persistedBytes = 0;
    private loadedBytes = 0;
    private lastUpdatedAt: number | null = null;
    private inspectionStatus: VectorStoreInspection["status"] = "absent";
    private inspectionReason: VectorStoreInspection["reasonCode"];
    private generationSequence = 0;

    constructor(private readonly storage: VaultCoachPersistentStore, private readonly now: () => number = () => Date.now()) {}

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        this.resetInMemoryState();
        const active = await this.tryLoadPointer(ACTIVE_POINTER_PATH);
        const activeGeneration = active ? await this.tryLoadGeneration(active.generationId) : null;
        if (activeGeneration) {
            this.applyLoadedGeneration(activeGeneration);
            return;
        }
        const backup = await this.tryLoadPointer(BACKUP_POINTER_PATH);
        const backupGeneration = backup ? await this.tryLoadGeneration(backup.generationId) : null;
        if (backupGeneration) {
            await this.restoreBackupPointer();
            this.applyLoadedGeneration(backupGeneration);
            return;
        }
        if (await this.storage.knowledgeIndexPathExists(LEGACY_MANIFEST_PATH)) {
            this.inspectionStatus = "legacy";
            this.inspectionReason = "unsupported-schema";
            return;
        }
        if (await this.storage.knowledgeIndexPathExists(ACTIVE_POINTER_PATH)
            || await this.storage.knowledgeIndexPathExists(BACKUP_POINTER_PATH)) {
            this.inspectionStatus = "corrupt";
            this.inspectionReason ??= "invalid-manifest";
        }
    }

    async replaceAll(records: readonly VectorRecord[], fingerprint: EmbeddingFingerprint): Promise<VectorStoreStats> {
        await this.initialize();
        validateEmbeddingFingerprint(fingerprint);
        const prepared = this.prepareRecords(records, fingerprint);
        if (prepared.length === 0) throw new EmbeddingError("invalid-request", fingerprint.providerId, "Cannot activate an empty vector generation.");
        const generationId = await this.createGenerationId();
        const root = `${VECTOR_ROOT}/generations/${generationId}`;
        const shardId = "shard-000001.bin";
        const vectorData = new Float32Array(prepared.length * fingerprint.dimension);
        prepared.forEach((record, index) => vectorData.set(record.vector, index * fingerprint.dimension));
        const shard = vectorData.buffer.slice(vectorData.byteOffset, vectorData.byteOffset + vectorData.byteLength);
        const manifest: EmbeddedVectorManifestV2 = {
            schemaVersion: 2,
            backend: "embedded-exact",
            generationId,
            fingerprint: cloneFingerprint(fingerprint),
            dimension: fingerprint.dimension,
            shardId,
            shardByteLength: shard.byteLength,
            vectorCount: prepared.length,
            records: prepared.map((record) => ({ chunkId: record.chunkId, metadata: { ...record.metadata } })),
            updatedAt: this.now(),
            persistedBytes: shard.byteLength,
        };
        try {
            await this.storage.saveKnowledgeIndexBinary(`${root}/${shardId}`, shard);
            await this.storage.saveKnowledgeIndexJson(`${root}/manifest.json`, manifest);
            const verified = await this.tryLoadGeneration(generationId);
            if (!verified) throw new Error("Vector generation verification failed.");
            await this.activateGeneration(generationId);
            this.applyLoadedGeneration(verified);
            await this.cleanupObsoleteGenerations().catch((error: unknown) => {
                console.warn("[VaultCoach] 无法清理旧向量 generation；当前 active generation 仍然有效。", error);
            });
            return this.getStats();
        } catch (error: unknown) {
            await this.storage.removeKnowledgeIndexPath(NEXT_POINTER_PATH).catch(() => undefined);
            await this.storage.clearKnowledgeIndexSubtree(`${VECTOR_ROOT}/generations/${generationId}`).catch(() => undefined);
            throw error;
        }
    }

    async upsert(records: readonly VectorRecord[], fingerprint: EmbeddingFingerprint): Promise<void> {
        await this.initialize();
        this.requireCompatibleFingerprint(fingerprint);
        if (records.length === 0) return;
        const merged = new Map(this.records);
        for (const record of this.prepareRecords(records, fingerprint)) merged.set(record.chunkId, record);
        await this.replaceAll(Array.from(merged.values()), fingerprint);
    }

    async remove(chunkIds: readonly string[]): Promise<void> {
        await this.initialize();
        if (!this.fingerprint || chunkIds.length === 0) return;
        const retained = Array.from(this.records.values()).filter((record) => !chunkIds.includes(record.chunkId));
        if (retained.length === this.records.size) return;
        if (retained.length === 0) return this.clear();
        await this.replaceAll(retained, this.fingerprint);
    }

    async search(queryVector: Float32Array, queryFingerprint: EmbeddingFingerprint, options: VectorSearchOptions): Promise<VectorStoreHit[]> {
        await this.initialize();
        this.requireCompatibleFingerprint(queryFingerprint);
        if (queryVector.length !== queryFingerprint.dimension) {
            throw new EmbeddingError("dimension-mismatch", queryFingerprint.providerId, "Query vector dimension does not match its fingerprint.");
        }
        const normalizedQuery = normalizeVector(queryVector);
        if (normalizedQuery.length === 0 || this.records.size === 0) return [];
        const heap: VectorStoreHit[] = [];
        const topK = Math.max(1, Math.floor(options.topK));
        for (const record of this.records.values()) {
            if (!this.matchesFilter(record, options)) continue;
            const similarity = dot(normalizedQuery, record.vector);
            pushTopK(heap, { chunkId: record.chunkId, score: similarity, similarity }, topK);
        }
        return heap.sort((left, right) => right.score - left.score);
    }

    async inspect(): Promise<VectorStoreInspection> {
        await this.initialize();
        return {
            status: this.inspectionStatus,
            fingerprint: this.fingerprint ? cloneFingerprint(this.fingerprint) : null,
            stats: await this.getStats(),
            ...(this.inspectionReason ? { reasonCode: this.inspectionReason } : {}),
        };
    }

    async clear(): Promise<void> {
        this.resetInMemoryState();
        this.initialized = true;
        await this.storage.clearKnowledgeIndexSubtree(VECTOR_ROOT);
    }

    async getStats(): Promise<VectorStoreStats> {
        await this.initialize();
        return { backend: "embedded-exact", vectorCount: this.records.size, dimension: this.fingerprint?.dimension ?? null,
            persistedBytes: this.persistedBytes, loadedBytes: this.loadedBytes, lastUpdatedAt: this.lastUpdatedAt };
    }

    async close(): Promise<void> {
        this.resetInMemoryState();
        this.initialized = false;
    }

    private prepareRecords(records: readonly VectorRecord[], fingerprint: EmbeddingFingerprint): StoredVectorRecord[] {
        const seen = new Set<string>();
        return records.map((record) => {
            if (!record.chunkId || seen.has(record.chunkId)) throw new EmbeddingError("invalid-request", fingerprint.providerId, "Vector batch contains an empty or duplicate chunk ID.");
            seen.add(record.chunkId);
            if (record.vector.length !== fingerprint.dimension) throw new EmbeddingError("dimension-mismatch", fingerprint.providerId, "Vector batch contains an incompatible dimension.");
            const vector = normalizeVector(record.vector);
            if (vector.length !== fingerprint.dimension) throw new EmbeddingError("malformed-response", fingerprint.providerId, "Vector batch contains a zero or non-finite vector.");
            return { chunkId: record.chunkId, vector, metadata: { ...record.metadata } };
        }).sort((left, right) => left.chunkId.localeCompare(right.chunkId));
    }

    private requireCompatibleFingerprint(fingerprint: EmbeddingFingerprint): void {
        validateEmbeddingFingerprint(fingerprint);
        if (!this.fingerprint || !areEmbeddingFingerprintsEqual(this.fingerprint, fingerprint)) {
            throw new EmbeddingError("fingerprint-mismatch", fingerprint.providerId, "Fingerprint does not match the active vector generation.");
        }
    }

    private async tryLoadPointer(path: string): Promise<VectorGenerationPointer | null> {
        const pointer = await this.storage.loadKnowledgeIndexJson<VectorGenerationPointer>(path);
        if (!pointer || pointer.schemaVersion !== 1 || !/^generation-[0-9]+-[0-9]+$/.test(pointer.generationId)) {
            if (await this.storage.knowledgeIndexPathExists(path)) this.inspectionReason = "invalid-manifest";
            return null;
        }
        return pointer;
    }

    private async tryLoadGeneration(generationId: string): Promise<LoadedGeneration | null> {
        const root = `${VECTOR_ROOT}/generations/${generationId}`;
        const manifest = await this.storage.loadKnowledgeIndexJson<EmbeddedVectorManifestV2>(`${root}/manifest.json`);
        if (!manifest || manifest.schemaVersion !== 2 || manifest.backend !== "embedded-exact" || manifest.generationId !== generationId
            || !/^shard-[0-9]+\.bin$/.test(manifest.shardId)) return this.invalidGeneration("invalid-manifest");
        try { validateEmbeddingFingerprint(manifest.fingerprint); } catch { return this.invalidGeneration("invalid-manifest"); }
        if (manifest.dimension !== manifest.fingerprint.dimension || manifest.vectorCount !== manifest.records.length
            || manifest.shardByteLength !== manifest.vectorCount * manifest.dimension * Float32Array.BYTES_PER_ELEMENT
            || manifest.persistedBytes !== manifest.shardByteLength
            || new Set(manifest.records.map((record) => record.chunkId)).size !== manifest.records.length) {
            return this.invalidGeneration("invalid-manifest");
        }
        const shard = await this.storage.loadKnowledgeIndexBinary(`${root}/${manifest.shardId}`);
        if (!shard) return this.invalidGeneration("missing-file");
        if (shard.byteLength !== manifest.shardByteLength) return this.invalidGeneration("invalid-shard");
        const data = new Float32Array(shard);
        const records = new Map<string, StoredVectorRecord>();
        for (let index = 0; index < manifest.records.length; index += 1) {
            const persisted = manifest.records[index];
            if (!persisted?.chunkId) return this.invalidGeneration("invalid-manifest");
            const vector = new Float32Array(data.slice(index * manifest.dimension, (index + 1) * manifest.dimension));
            if (vector.some((value) => !Number.isFinite(value))) return this.invalidGeneration("invalid-shard");
            records.set(persisted.chunkId, { chunkId: persisted.chunkId, vector, metadata: { ...persisted.metadata } });
        }
        return { manifest, records };
    }

    private invalidGeneration(reason: VectorStoreInspection["reasonCode"]): null {
        this.inspectionReason = reason;
        return null;
    }

    private async activateGeneration(generationId: string): Promise<void> {
        await this.storage.saveKnowledgeIndexJson(NEXT_POINTER_PATH, { schemaVersion: 1, generationId } satisfies VectorGenerationPointer);
        if (await this.storage.knowledgeIndexPathExists(BACKUP_POINTER_PATH)) await this.storage.removeKnowledgeIndexPath(BACKUP_POINTER_PATH);
        const hadActive = await this.storage.knowledgeIndexPathExists(ACTIVE_POINTER_PATH);
        if (hadActive) await this.storage.moveKnowledgeIndexPath(ACTIVE_POINTER_PATH, BACKUP_POINTER_PATH);
        try {
            await this.storage.moveKnowledgeIndexPath(NEXT_POINTER_PATH, ACTIVE_POINTER_PATH);
        } catch (error: unknown) {
            if (hadActive && await this.storage.knowledgeIndexPathExists(BACKUP_POINTER_PATH)
                && !(await this.storage.knowledgeIndexPathExists(ACTIVE_POINTER_PATH))) {
                await this.storage.moveKnowledgeIndexPath(BACKUP_POINTER_PATH, ACTIVE_POINTER_PATH).catch(() => undefined);
            }
            throw error;
        }
    }

    private async restoreBackupPointer(): Promise<void> {
        if (await this.storage.knowledgeIndexPathExists(ACTIVE_POINTER_PATH)) await this.storage.removeKnowledgeIndexPath(ACTIVE_POINTER_PATH);
        if (await this.storage.knowledgeIndexPathExists(BACKUP_POINTER_PATH)) await this.storage.moveKnowledgeIndexPath(BACKUP_POINTER_PATH, ACTIVE_POINTER_PATH);
    }

    private async cleanupObsoleteGenerations(): Promise<void> {
        const active = await this.tryLoadPointer(ACTIVE_POINTER_PATH);
        const backup = await this.tryLoadPointer(BACKUP_POINTER_PATH);
        const retained = new Set([active?.generationId, backup?.generationId].filter((value): value is string => !!value));
        for (const generationId of await this.storage.listKnowledgeIndexFolders(`${VECTOR_ROOT}/generations`)) {
            if (/^generation-[0-9]+-[0-9]+$/.test(generationId) && !retained.has(generationId)) {
                await this.storage.clearKnowledgeIndexSubtree(`${VECTOR_ROOT}/generations/${generationId}`);
            }
        }
    }

    private applyLoadedGeneration(loaded: LoadedGeneration): void {
        this.records.clear();
        loaded.records.forEach((record, id) => this.records.set(id, record));
        this.fingerprint = cloneFingerprint(loaded.manifest.fingerprint);
        this.persistedBytes = loaded.manifest.persistedBytes;
        this.loadedBytes = loaded.manifest.shardByteLength;
        this.lastUpdatedAt = loaded.manifest.updatedAt;
        this.inspectionStatus = "ready";
        this.inspectionReason = undefined;
    }

    private resetInMemoryState(): void {
        this.records.clear();
        this.fingerprint = null;
        this.persistedBytes = 0;
        this.loadedBytes = 0;
        this.lastUpdatedAt = null;
        this.inspectionStatus = "absent";
        this.inspectionReason = undefined;
    }

    private async createGenerationId(): Promise<string> {
        while (true) {
            const candidate = `generation-${this.now()}-${++this.generationSequence}`;
            if (!(await this.storage.knowledgeIndexPathExists(`${VECTOR_ROOT}/generations/${candidate}`))) return candidate;
        }
    }

    private matchesFilter(record: StoredVectorRecord, options: VectorSearchOptions): boolean {
        const filter = options.filter;
        if (!filter) return true;
        if (filter.documentIds && !filter.documentIds.includes(record.metadata.documentId)) return false;
        if (filter.documentTypes && !filter.documentTypes.includes(record.metadata.documentType)) return false;
        if (filter.folderPaths?.length) {
            const path = normalizePath(record.metadata.filePath ?? "");
            if (!filter.folderPaths.some((folder) => {
                const normalized = normalizePath(folder.trim()).replace(/\/$/, "");
                return !normalized || path === normalized || path.startsWith(`${normalized}/`);
            })) return false;
        }
        return true;
    }
}

function cloneFingerprint(value: EmbeddingFingerprint): EmbeddingFingerprint {
    return { ...value, preprocessing: { ...value.preprocessing } };
}

function dot(left: Float32Array, right: Float32Array): number {
    if (left.length !== right.length) throw new Error("Vector dimensions changed after validation.");
    let score = 0;
    for (let index = 0; index < left.length; index += 1) score += (left[index] ?? 0) * (right[index] ?? 0);
    return score;
}

function pushTopK(heap: VectorStoreHit[], hit: VectorStoreHit, topK: number): void {
    if (heap.length < topK) {
        heap.push(hit);
        siftUp(heap, heap.length - 1);
        return;
    }
    if (!heap[0] || hit.score <= heap[0].score) return;
    heap[0] = hit;
    siftDown(heap, 0);
}

function siftUp(heap: VectorStoreHit[], index: number): void {
    let child = index;
    while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if ((heap[parent]?.score ?? Number.NEGATIVE_INFINITY) <= (heap[child]?.score ?? Number.NEGATIVE_INFINITY)) break;
        [heap[parent], heap[child]] = [heap[child] as VectorStoreHit, heap[parent] as VectorStoreHit];
        child = parent;
    }
}

function siftDown(heap: VectorStoreHit[], index: number): void {
    let parent = index;
    while (true) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if ((heap[left]?.score ?? Infinity) < (heap[smallest]?.score ?? Infinity)) smallest = left;
        if ((heap[right]?.score ?? Infinity) < (heap[smallest]?.score ?? Infinity)) smallest = right;
        if (smallest === parent) return;
        [heap[parent], heap[smallest]] = [heap[smallest] as VectorStoreHit, heap[parent] as VectorStoreHit];
        parent = smallest;
    }
}
