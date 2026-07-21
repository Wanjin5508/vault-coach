import { normalizePath } from "obsidian";
import {
    GRAPH_DIR_PATH,
    SEMANTIC_GRAPH_DIR_PATH,
    SEMANTIC_GRAPH_MANIFEST_PATH,
    VAULT_COACH_HIDDEN_DIR_PATH,
} from "../../constants";
import { stableSemanticHash } from "../../domain/semantic-graph/concept-candidate-fingerprint";
import { SemanticGraphIntegrityService } from "../../domain/semantic-graph/semantic-graph-integrity";
import { SEMANTIC_GRAPH_SCHEMA_VERSION, type SemanticGraphState } from "../../domain/semantic-graph/semantic-graph-types";
import type { SemanticGraphStore } from "../../domain/semantic-graph/semantic-graph-store";

/** Minimal vault adapter needed for recoverable, shard-based semantic graph persistence. */
export interface SemanticGraphStorageAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    remove(path: string): Promise<void>;
}

interface SemanticGraphManifestV1 {
    schemaVersion: typeof SEMANTIC_GRAPH_SCHEMA_VERSION;
    updatedAt: number;
    sectionShardPaths: string[];
    conceptShardPaths: string[];
    candidateShardPaths: string[];
    decisionsPath: string;
    embeddingsPath: string;
}

interface SectionShard { extractions: SemanticGraphState["extractions"]; }
interface ConceptShard { concepts: SemanticGraphState["concepts"]; }
interface CandidateShard { candidates: SemanticGraphState["candidates"]; }
interface DecisionsShard { decisions: SemanticGraphState["decisions"]; }
interface EmbeddingsShard { embeddings: SemanticGraphState["embeddings"]; }

/**
 * Persists semantic facts in independently replaceable JSON shards. The manifest
 * is committed last, so an interrupted update retains the previous coherent set.
 */
export class JsonSemanticGraphStore implements SemanticGraphStore {
    private readonly integrity = new SemanticGraphIntegrityService();

    constructor(private readonly adapter: SemanticGraphStorageAdapter) {}

    async load(): Promise<SemanticGraphState | null> {
        await this.ensureDirectories();
        await this.recoverJsonFile(SEMANTIC_GRAPH_MANIFEST_PATH);
        if (!(await this.adapter.exists(SEMANTIC_GRAPH_MANIFEST_PATH))) return null;
        const manifest = await this.readManifest(SEMANTIC_GRAPH_MANIFEST_PATH);
        const [sectionShards, conceptShards, candidateShards, decisions, embeddings] = await Promise.all([
            Promise.all(manifest.sectionShardPaths.map(async (path) => this.readJson<SectionShard>(path))),
            Promise.all(manifest.conceptShardPaths.map(async (path) => this.readJson<ConceptShard>(path))),
            Promise.all(manifest.candidateShardPaths.map(async (path) => this.readJson<CandidateShard>(path))),
            this.readJson<DecisionsShard>(manifest.decisionsPath),
            this.readJson<EmbeddingsShard>(manifest.embeddingsPath),
        ]);
        const state: SemanticGraphState = {
            schemaVersion: manifest.schemaVersion,
            extractions: sectionShards.flatMap((shard) => shard.extractions ?? []),
            concepts: conceptShards.flatMap((shard) => shard.concepts ?? []),
            candidates: candidateShards.flatMap((shard) => shard.candidates ?? []),
            decisions: decisions.decisions ?? [],
            embeddings: embeddings.embeddings ?? [],
            updatedAt: manifest.updatedAt,
        };
        this.assertState(state, SEMANTIC_GRAPH_MANIFEST_PATH);
        return state;
    }

    async save(state: SemanticGraphState): Promise<void> {
        await this.ensureDirectories();
        this.assertState(state, "semantic graph state");
        const previous = await this.tryReadManifest();
        const sectionShards = this.groupByPath(state.extractions, (record) => `sections/${stableSemanticHash(record.documentPath).slice(0, 2)}.json`);
        const conceptShards = this.groupByPath(state.concepts, (concept) => `concepts/${concept.id.slice(-2)}.json`);
        const candidateShards = this.groupByPath(state.candidates, (candidate) => `candidates/${candidate.fingerprint.slice(-2)}.json`);
        const decisionsPath = "decisions-v1.json";
        const embeddingsPath = "embeddings/records-v1.json";
        const paths = new Set<string>();

        for (const [relativePath, extractions] of sectionShards) {
            const path = this.resolve(relativePath);
            paths.add(path);
            await this.writeJsonAtomically(path, { extractions });
        }
        for (const [relativePath, concepts] of conceptShards) {
            const path = this.resolve(relativePath);
            paths.add(path);
            await this.writeJsonAtomically(path, { concepts });
        }
        for (const [relativePath, candidates] of candidateShards) {
            const path = this.resolve(relativePath);
            paths.add(path);
            await this.writeJsonAtomically(path, { candidates });
        }
        const decisionFilePath = this.resolve(decisionsPath);
        const embeddingFilePath = this.resolve(embeddingsPath);
        paths.add(decisionFilePath);
        paths.add(embeddingFilePath);
        await this.writeJsonAtomically(decisionFilePath, { decisions: state.decisions });
        await this.writeJsonAtomically(embeddingFilePath, { embeddings: state.embeddings });

        const manifest: SemanticGraphManifestV1 = {
            schemaVersion: SEMANTIC_GRAPH_SCHEMA_VERSION,
            updatedAt: state.updatedAt,
            sectionShardPaths: Array.from(sectionShards.keys()).map((path) => this.resolve(path)).sort(),
            conceptShardPaths: Array.from(conceptShards.keys()).map((path) => this.resolve(path)).sort(),
            candidateShardPaths: Array.from(candidateShards.keys()).map((path) => this.resolve(path)).sort(),
            decisionsPath: decisionFilePath,
            embeddingsPath: embeddingFilePath,
        };
        await this.writeJsonAtomically(SEMANTIC_GRAPH_MANIFEST_PATH, manifest);
        await this.removeObsoleteShards(previous, paths);
    }

    async clear(): Promise<void> {
        const manifest = await this.tryReadManifest();
        const paths = manifest ? this.getManifestDataPaths(manifest) : [];
        for (const path of [...paths, SEMANTIC_GRAPH_MANIFEST_PATH]) {
            await this.removeWithStages(path);
        }
    }

    private groupByPath<T>(items: readonly T[], getPath: (item: T) => string): Map<string, T[]> {
        const groups = new Map<string, T[]>();
        for (const item of items) {
            const path = getPath(item);
            const group = groups.get(path) ?? [];
            group.push(item);
            groups.set(path, group);
        }
        for (const group of groups.values()) {
            group.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        }
        return groups;
    }

    private async tryReadManifest(): Promise<SemanticGraphManifestV1 | null> {
        await this.recoverJsonFile(SEMANTIC_GRAPH_MANIFEST_PATH);
        if (!(await this.adapter.exists(SEMANTIC_GRAPH_MANIFEST_PATH))) return null;
        return this.readManifest(SEMANTIC_GRAPH_MANIFEST_PATH);
    }

    private async readManifest(path: string): Promise<SemanticGraphManifestV1> {
        const manifest = await this.readJson<SemanticGraphManifestV1>(path);
        if (manifest.schemaVersion !== SEMANTIC_GRAPH_SCHEMA_VERSION
            || !Array.isArray(manifest.sectionShardPaths)
            || !Array.isArray(manifest.conceptShardPaths)
            || !Array.isArray(manifest.candidateShardPaths)
            || typeof manifest.decisionsPath !== "string"
            || typeof manifest.embeddingsPath !== "string"
            || !Number.isFinite(manifest.updatedAt)) {
            throw new Error(`语义图谱 manifest 格式无效：${path}`);
        }
        return manifest;
    }

    private async readJson<T>(path: string): Promise<T> {
        await this.recoverJsonFile(path);
        try {
            return JSON.parse(await this.adapter.read(path)) as T;
        } catch (error: unknown) {
            throw new Error(`语义图谱 JSON 无法解析：${path}（${this.describeError(error)}）`);
        }
    }

    private async writeJsonAtomically(path: string, value: unknown): Promise<void> {
        const temporaryPath = `${path}.tmp`;
        const backupPath = `${path}.bak`;
        const serialized = JSON.stringify(value, null, 2);
        await this.adapter.write(temporaryPath, serialized);
        await this.readJson<unknown>(temporaryPath);
        if (!(await this.adapter.exists(path))) {
            await this.adapter.rename(temporaryPath, path);
            return;
        }
        await this.removeIfPresent(backupPath);
        await this.adapter.write(backupPath, await this.adapter.read(path));
        try {
            await this.adapter.remove(path);
            await this.adapter.rename(temporaryPath, path);
        } catch (error: unknown) {
            if (!(await this.adapter.exists(path)) && await this.adapter.exists(backupPath)) {
                await this.adapter.rename(backupPath, path);
            }
            throw error;
        }
        await this.removeIfPresent(backupPath);
    }

    private async recoverJsonFile(path: string): Promise<void> {
        const temporaryPath = `${path}.tmp`;
        const backupPath = `${path}.bak`;
        if (await this.adapter.exists(path)) {
            await this.removeIfPresent(temporaryPath);
            await this.removeIfPresent(backupPath);
            return;
        }
        for (const stagedPath of [temporaryPath, backupPath]) {
            if (!(await this.adapter.exists(stagedPath))) continue;
            try {
                JSON.parse(await this.adapter.read(stagedPath));
                await this.adapter.rename(stagedPath, path);
                await this.removeIfPresent(temporaryPath);
                await this.removeIfPresent(backupPath);
                return;
            } catch (error: unknown) {
                console.warn("[VaultCoach] 保留无法恢复的语义图谱暂存文件", stagedPath, error);
            }
        }
    }

    private async removeObsoleteShards(previous: SemanticGraphManifestV1 | null, nextPaths: ReadonlySet<string>): Promise<void> {
        if (!previous) return;
        for (const path of this.getManifestDataPaths(previous)) {
            if (!nextPaths.has(path)) await this.removeWithStages(path);
        }
    }

    private getManifestDataPaths(manifest: SemanticGraphManifestV1): string[] {
        return [
            ...manifest.sectionShardPaths,
            ...manifest.conceptShardPaths,
            ...manifest.candidateShardPaths,
            manifest.decisionsPath,
            manifest.embeddingsPath,
        ];
    }

    private assertState(state: SemanticGraphState, path: string): void {
        const report = this.integrity.check(state);
        if (!report.valid) {
            throw new Error(`语义图谱完整性校验失败：${path}（${report.issues.map((issue) => issue.code).join(", ")}）`);
        }
    }

    private async ensureDirectories(): Promise<void> {
        for (const path of [
            VAULT_COACH_HIDDEN_DIR_PATH,
            GRAPH_DIR_PATH,
            SEMANTIC_GRAPH_DIR_PATH,
            `${SEMANTIC_GRAPH_DIR_PATH}/sections`,
            `${SEMANTIC_GRAPH_DIR_PATH}/concepts`,
            `${SEMANTIC_GRAPH_DIR_PATH}/candidates`,
            `${SEMANTIC_GRAPH_DIR_PATH}/embeddings`,
        ]) {
            const normalized = normalizePath(path);
            if (!(await this.adapter.exists(normalized))) await this.adapter.mkdir(normalized);
        }
    }

    private async removeWithStages(path: string): Promise<void> {
        await this.removeIfPresent(path);
        await this.removeIfPresent(`${path}.tmp`);
        await this.removeIfPresent(`${path}.bak`);
    }

    private async removeIfPresent(path: string): Promise<void> {
        if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }

    private resolve(relativePath: string): string {
        return normalizePath(`${SEMANTIC_GRAPH_DIR_PATH}/${relativePath}`);
    }

    private describeError(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
