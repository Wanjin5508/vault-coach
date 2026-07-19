import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExamScopeService } from "../src/exam/exam-scope-service";
import type {
    ExamContentProfile,
    ExamFileOption,
    ExamScopeSelection,
} from "../src/domain/exam/exam-types";
import type {
    DocumentFileMetadata,
    DocumentFileMetadataReader,
} from "../src/domain/documents/document-file-metadata-reader";
import type { DocumentIndexReader } from "../src/domain/documents/document-index-reader";
import type { IndexedChunk, KnowledgeBaseFileRecord, KnowledgeBaseStats } from "../src/domain/documents/document-types";
import type { VaultCoachSettings } from "../src/app/config/settings-types";

interface ExamScopeFixture {
    selection: ExamScopeSelection;
    fileOptions: ExamFileOption[];
    chunks: IndexedChunk[];
    profiles: ExamContentProfile[];
}

interface ScopeServiceOptions {
    fileMetadataByPath?: Map<string, DocumentFileMetadata | null>;
    fileRecordOverrides?: Map<string, Partial<KnowledgeBaseFileRecord>>;
}

function readFixture(): ExamScopeFixture {
    const fixturePath = fileURLToPath(new URL("./fixtures/exam-scope.json", import.meta.url));
    return JSON.parse(readFileSync(fixturePath, "utf8")) as ExamScopeFixture;
}

function createExamReadyChunk(fileOption: ExamFileOption, id: string): IndexedChunk {
    return {
        id,
        documentId: `markdown:${fileOption.filePath}`,
        documentType: "markdown",
        filePath: fileOption.filePath,
        fileName: fileOption.fileName,
        headingPath: [fileOption.fileName.replace(/\.md$/i, "")],
        primaryHeading: fileOption.fileName.replace(/\.md$/i, ""),
        text: "这是用于验证考试范围迁移行为的完整知识内容。".repeat(5),
        searchableText: fileOption.fileName,
        locator: {
            type: "markdown",
            filePath: fileOption.filePath,
        },
        contentKind: "native-text",
    };
}

function createScopeService(fixture: ExamScopeFixture, options: ScopeServiceOptions = {}): ExamScopeService {
    const fixtureChunks: IndexedChunk[] = fixture.chunks.map((chunk: IndexedChunk) => ({
        ...chunk,
        text: `${chunk.text} ${"用于考试范围测试的知识正文。".repeat(8)}`,
    }));
    const filePathsWithChunks: Set<string> = new Set(fixtureChunks.map((chunk: IndexedChunk) => chunk.filePath));
    for (const fileOption of fixture.fileOptions) {
        if (!filePathsWithChunks.has(fileOption.filePath)) {
            fixtureChunks.push(createExamReadyChunk(fileOption, `fixture-${fileOption.fileName}`));
        }
    }

    const chunksByPath: Map<string, IndexedChunk[]> = new Map<string, IndexedChunk[]>();
    for (const chunk of fixtureChunks) {
        const chunks: IndexedChunk[] = chunksByPath.get(chunk.filePath) ?? [];
        chunks.push(chunk);
        chunksByPath.set(chunk.filePath, chunks);
    }

    const fileRecords: KnowledgeBaseFileRecord[] = fixture.fileOptions.map((fileOption: ExamFileOption) => ({
        documentId: `markdown:${fileOption.filePath}`,
        documentType: "markdown",
        filePath: fileOption.filePath,
        contentHash: `hash:${fileOption.filePath}`,
        chunkIds: (chunksByPath.get(fileOption.filePath) ?? []).map((chunk: IndexedChunk) => chunk.id),
        indexedAt: 1,
        ...options.fileRecordOverrides?.get(fileOption.filePath),
    }));
    const stats: KnowledgeBaseStats = {
        fileCount: fileRecords.length,
        chunkCount: fixtureChunks.length,
        lastIndexedAt: 1,
        scopeDescription: "fixture",
    };
    const documentIndex: DocumentIndexReader = {
        isReady: () => true,
        getStats: () => ({ ...stats }),
        getAllChunks: () => [...fixtureChunks],
        getChunkById: (chunkId: string) => fixtureChunks.find((chunk: IndexedChunk) => chunk.id === chunkId) ?? null,
        getChunksByIds: (chunkIds: readonly string[]) => chunkIds
            .map((chunkId: string) => fixtureChunks.find((chunk: IndexedChunk) => chunk.id === chunkId))
            .filter((chunk: IndexedChunk | undefined): chunk is IndexedChunk => chunk !== undefined),
        getChunksByFilePath: (filePath: string) => [...(chunksByPath.get(filePath) ?? [])],
        getFileRecords: () => fileRecords.map((record: KnowledgeBaseFileRecord) => ({
            ...record,
            chunkIds: [...record.chunkIds],
        })),
        getFileRecord: (filePath: string) => {
            const record: KnowledgeBaseFileRecord | undefined = fileRecords.find((item: KnowledgeBaseFileRecord) => item.filePath === filePath);
            return record ? { ...record, chunkIds: [...record.chunkIds] } : null;
        },
        readDocumentText: async (filePath: string) => (chunksByPath.get(filePath) ?? [])
            .map((chunk: IndexedChunk) => chunk.text)
            .join("\n\n"),
        searchKeyword: () => [],
    };
    const fileMetadataReader: DocumentFileMetadataReader = {
        getFileMetadata: (filePath: string) => {
            if (options.fileMetadataByPath?.has(filePath)) {
                return options.fileMetadataByPath.get(filePath) ?? null;
            }

            return { frontmatter: null };
        },
    };
    const settings: VaultCoachSettings = {
        examExcludePathPatterns: "知识库/规则排除.md",
    } as VaultCoachSettings;

    return new ExamScopeService(documentIndex, fileMetadataReader, () => settings);
}

describe("exam scope behavior", () => {
    it("keeps rule and manual exclusions separate", () => {
        const fixture = readFixture();
        const service = createScopeService(fixture);

        const resolved = service.resolveScope(fixture.selection);

        expect(resolved.ruleExcludedFiles.map((file) => file.filePath)).toEqual(["知识库/规则排除.md"]);
        expect(resolved.manualExcludedFiles.map((file) => file.filePath)).toEqual(["知识库/排除.md"]);
        expect(resolved.candidateFiles.map((file) => file.filePath)).toEqual([
            "知识库/主题.md",
            "知识库/强制包含.md",
        ]);
    });

    it("keeps only eligible headings while honoring force inclusion", () => {
        const fixture = readFixture();
        const service = createScopeService(fixture);

        const eligibleChunks = service.getEligibleChunks(fixture.selection, fixture.profiles, true);

        expect(eligibleChunks.map((chunk) => chunk.id)).toEqual([
            "chunk-theme-1",
            "chunk-forced-1",
        ]);
    });

    it("builds stable analysis counts and question capacity", () => {
        const fixture = readFixture();
        const service = createScopeService(fixture);
        const resolved = service.resolveScope(fixture.selection);
        const eligibleChunks = service.getEligibleChunks(fixture.selection, fixture.profiles, true);

        const result = service.buildAnalysisResult(
            fixture.selection,
            resolved,
            fixture.profiles,
            eligibleChunks,
            "exam-content-profile-v1",
            1,
            0,
        );

        expect(result.eligibleChunkIds).toEqual(["chunk-theme-1", "chunk-forced-1"]);
        expect(result.summary).toMatchObject({
            totalFiles: 4,
            ruleExcludedFiles: 1,
            manualExcludedFiles: 1,
            partialFiles: 1,
            includedFiles: 1,
            eligibleChunkCount: 2,
            estimatedMinQuestions: 1,
            estimatedMaxQuestions: 1,
            cacheHits: 1,
            cacheMisses: 0,
        });
    });

    it("builds folder options and snapshots from the generic document index", () => {
        const fixture = readFixture();
        const service = createScopeService(fixture);

        expect(service.getFolderScopeOptions()).toEqual([
            expect.objectContaining({
                folderPath: "知识库",
                fileCount: 4,
                chunkCount: 5,
            }),
        ]);
        expect(service.getScopeSnapshot(fixture.selection)).toEqual({
            totalFileCount: 4,
            eligibleFileCount: 2,
            excludedFileCount: 2,
            eligibleChunkCount: 3,
            estimatedMinQuestions: 1,
            estimatedMaxQuestions: 2,
        });
        expect(service.getChunksForScope(fixture.selection).map((chunk) => chunk.id)).toEqual([
            "chunk-theme-1",
            "chunk-theme-2",
            "chunk-forced-1",
        ]);
    });

    it("preserves live frontmatter, missing-file, PDF, and user-rule exclusions", () => {
        const fixture = readFixture();
        const service = createScopeService(fixture, {
            fileMetadataByPath: new Map<string, DocumentFileMetadata | null>([
                ["知识库/主题.md", { frontmatter: { vault_coach_exam: false } }],
                ["知识库/强制包含.md", null],
            ]),
            fileRecordOverrides: new Map<string, Partial<KnowledgeBaseFileRecord>>([
                ["知识库/排除.md", { documentType: "pdf", extractionQuality: 0.2 }],
            ]),
        });

        expect(service.getFileOptions(["知识库"]).map((file) => ({
            filePath: file.filePath,
            reason: file.permanentExcludeReason,
        }))).toEqual([
            { filePath: "知识库/主题.md", reason: "vault_coach_exam: false" },
            { filePath: "知识库/强制包含.md", reason: "File no longer exists" },
            { filePath: "知识库/排除.md", reason: "Low PDF extraction quality" },
            { filePath: "知识库/规则排除.md", reason: "Matched exclude rule: 知识库/规则排除.md" },
        ]);
    });
});
