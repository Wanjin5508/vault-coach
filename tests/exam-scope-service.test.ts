import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExamScopeService } from "../src/exam/exam-scope-service";
import type {
    ExamContentProfile,
    ExamFileOption,
    ExamScopeSelection,
} from "../src/domain/exam/exam-types";
import type { IndexedChunk } from "../src/domain/documents/document-types";

interface ExamScopeFixture {
    selection: ExamScopeSelection;
    fileOptions: ExamFileOption[];
    chunks: IndexedChunk[];
    profiles: ExamContentProfile[];
}

function readFixture(): ExamScopeFixture {
    const fixturePath = fileURLToPath(new URL("./fixtures/exam-scope.json", import.meta.url));
    return JSON.parse(readFileSync(fixturePath, "utf8")) as ExamScopeFixture;
}

describe("exam scope behavior", () => {
    it("keeps rule and manual exclusions separate", () => {
        const fixture = readFixture();
        const fakeKnowledgeBase = {
            getExamFileOptions: () => fixture.fileOptions,
            getExamFileChunks: (filePath: string) => fixture.chunks.filter((chunk) => chunk.filePath === filePath),
        };
        const service = new ExamScopeService(fakeKnowledgeBase as never);

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
        const fakeKnowledgeBase = {
            getExamFileOptions: () => fixture.fileOptions,
            getExamFileChunks: (filePath: string) => fixture.chunks.filter((chunk) => chunk.filePath === filePath),
        };
        const service = new ExamScopeService(fakeKnowledgeBase as never);

        const eligibleChunks = service.getEligibleChunks(fixture.selection, fixture.profiles, true);

        expect(eligibleChunks.map((chunk) => chunk.id)).toEqual([
            "chunk-theme-1",
            "chunk-forced-1",
        ]);
    });

    it("builds stable analysis counts and question capacity", () => {
        const fixture = readFixture();
        const fakeKnowledgeBase = {
            getExamFileOptions: () => fixture.fileOptions,
            getExamFileChunks: (filePath: string) => fixture.chunks.filter((chunk) => chunk.filePath === filePath),
        };
        const service = new ExamScopeService(fakeKnowledgeBase as never);
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
});
