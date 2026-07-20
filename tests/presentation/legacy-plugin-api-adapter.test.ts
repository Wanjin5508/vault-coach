import { describe, expect, it, vi } from "vitest";
import { LegacyPluginApiAdapter, type LegacyPluginApiHost } from "../../src/presentation/legacy-plugin-api-adapter";
import type { VaultCoachApplicationApi } from "../../src/app/application-api";
import type { VaultCoachSettings } from "../../src/app/config/settings-types";

describe("LegacyPluginApiAdapter", () => {
    it("delegates chat, exam, and non-notice index actions to grouped application APIs", async () => {
        const appendUserMessage = vi.fn(async () => undefined);
        const resetConversation = vi.fn();
        const createSession = vi.fn(async () => ({ id: "exam-1" }));
        const submitSession = vi.fn(async () => ({ id: "exam-1", status: "submitted" }));
        const rebuild = vi.fn(async () => undefined);
        const clear = vi.fn(async () => undefined);
        const abort = vi.fn();
        const listHistory = vi.fn(async () => [{ path: ".vault-coach/assessments/sessions/exam-1.json", title: "结构化记录", createdAt: 1, score: 80, maxScore: 100, modifiedAt: 1 }]);
        const readHistory = vi.fn(async () => "结构化报告");
        const deleteHistory = vi.fn(async () => undefined);
        const hostRebuild = vi.fn(async () => undefined);
        const hostClear = vi.fn(async () => undefined);
        const hostAbort = vi.fn();

        const application = {
            chat: {
                getMessages: () => [{ role: "assistant", text: "你好", createdAt: 1 }],
                appendUserMessage,
                streamAssistantTurn: async () => ({ text: "回答", sources: [], retrievalModeUsed: "keyword", rewriteResult: { originalQuery: "", rewrittenQuery: "", useRewrite: false } }),
                resetConversation,
            },
            exam: {
                getScopeOptions: () => [],
                getFileOptions: () => [],
                getScopeSnapshot: () => ({ eligibleChunkCount: 0, estimatedMaxQuestions: 0, excludedFileCount: 0 }),
                analyzeScope: async () => ({ profiles: [], eligibleChunkCount: 0, estimatedMaxQuestions: 0 }),
                createSession,
                submitSession,
                saveSession: async (session: unknown) => session,
                exportSession: async () => "VaultCoach Exams/exam.md",
                listHistory,
                readHistory,
                deleteSession: async () => undefined,
                deleteHistory,
            },
            index: {
                rebuild,
                clear,
                abort,
                getState: () => ({ textDirty: false, vectorDirty: false, busy: { busy: false, phase: null, startedAt: null }, stats: {}, vectorStats: {} }),
            },
            progress: { isAvailable: () => false },
        } as unknown as VaultCoachApplicationApi;
        const host = {
            settings: {} as VaultCoachSettings,
            rebuildKnowledgeBase: hostRebuild,
            clearKnowledgeIndex: hostClear,
            abortKnowledgeIndexBuild: hostAbort,
        } as unknown as LegacyPluginApiHost;
        const adapter = new LegacyPluginApiAdapter(application, host);

        await adapter.appendUserMessage("问题");
        adapter.resetConversation();
        await adapter.createExamSession({ selectedFolderPaths: [], excludedFilePaths: [], forceIncludedFilePaths: [] }, 3);
        await adapter.evaluateExamSession({ id: "exam-1" } as never, ["答案"]);
        await expect(adapter.listExamHistory()).resolves.toHaveLength(1);
        await expect(adapter.readExamHistoryContent(".vault-coach/assessments/sessions/exam-1.json")).resolves.toBe("结构化报告");
        await adapter.deleteExamHistory(".vault-coach/assessments/sessions/exam-1.json");
        await adapter.rebuildKnowledgeBase(false);
        await adapter.clearKnowledgeIndex(false);
        adapter.abortKnowledgeIndexBuild(false);

        expect(appendUserMessage).toHaveBeenCalledWith("问题");
        expect(resetConversation).toHaveBeenCalledOnce();
        expect(createSession).toHaveBeenCalledOnce();
        expect(submitSession).toHaveBeenCalledOnce();
        expect(listHistory).toHaveBeenCalledOnce();
        expect(readHistory).toHaveBeenCalledWith(".vault-coach/assessments/sessions/exam-1.json");
        expect(deleteHistory).toHaveBeenCalledWith(".vault-coach/assessments/sessions/exam-1.json");
        expect(rebuild).toHaveBeenCalledOnce();
        expect(clear).toHaveBeenCalledOnce();
        expect(abort).toHaveBeenCalledOnce();
        expect(adapter.getMessages()).toEqual([{ role: "assistant", text: "你好", createdAt: 1 }]);

        await adapter.rebuildKnowledgeBase(true);
        await adapter.clearKnowledgeIndex(true);
        adapter.abortKnowledgeIndexBuild(true);
        expect(hostRebuild).toHaveBeenCalledWith(true, undefined);
        expect(hostClear).toHaveBeenCalledWith(true);
        expect(hostAbort).toHaveBeenCalledWith(true);
    });
});
