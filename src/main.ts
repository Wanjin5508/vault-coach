import { Notice, Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_VAULT_COACH } from "./constants";
import { VaultKnowledgeBase } from "./knowledge-base";
import { VaultCoachPersistentStore } from "./persistent-store";
import { AdvancedRagEngine } from "./rag-engine";
import { DEFAULT_SETTINGS, VaultCoachSettingTab } from "./settings";
import type {
    AnswerSource,
    AssistantAnswer,
    ChatMessage,
    KnowledgeBaseSnapshot,
    KnowledgeBaseStats,
    KnowledgeBaseSyncResult,
    MemoryItem,
    MemorySearchHit,
    PersistedPluginState,
    RetrievalMode,
    StreamHandlers,
    VectorIndexStats,
    VaultCoachSettings,
} from "./types";
import { VaultCoachView } from "./view";

export default class VaultCoach extends Plugin {
    settings: VaultCoachSettings = DEFAULT_SETTINGS;

    private messages: ChatMessage[] = [];
    private memories: MemoryItem[] = [];

    private knowledgeBase!: VaultKnowledgeBase;
    private ragEngine!: AdvancedRagEngine;
    private persistentStore!: VaultCoachPersistentStore;

    private knowledgeBaseDirty = true;
    private vectorIndexDirty = true;
    private runtimeRetrievalMode: RetrievalMode = DEFAULT_SETTINGS.defaultRetrievalMode;

    // 新增：自动增量同步所需的队列与计时器。
    private readonly pendingChangedMarkdownPaths: Set<string> = new Set<string>();
    private autoIndexDebounceTimer: number | null = null;
    private autoIndexMaxWaitTimer: number | null = null;
    private isSyncingKnowledgeBase = false;
    private lastAutoIndexAt: number | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.runtimeRetrievalMode = this.settings.defaultRetrievalMode;
        this.knowledgeBase = new VaultKnowledgeBase(this.app, () => this.settings);
        this.ragEngine = new AdvancedRagEngine(
            this.knowledgeBase,
            () => this.settings,
            () => this.runtimeRetrievalMode,
        );
        this.persistentStore = new VaultCoachPersistentStore(this.app, this.manifest.id);

        await this.restorePersistentState();
        await this.restoreKnowledgeBaseSnapshot();

        if (this.messages.length === 0) {
            this.resetConversation();
        }

        this.registerView(
            VIEW_TYPE_VAULT_COACH,
            (leaf: WorkspaceLeaf) => new VaultCoachView(leaf, this),
        );

        this.addCommand({
            id: "open-view",
            name: "Open the sidebar view on the right side",
            callback: async () => {
                await this.activateView();
            },
        });

        this.addCommand({
            id: "reset-conversation",
            name: "Reset plugin conversation",
            callback: () => {
                this.resetConversation();
                this.refreshAllViews();
                new Notice("Reset successful.");
            },
        });

        this.addCommand({
            id: "rebuild-knowledge-index",
            name: "Rebuild Markdown knowledge index",
            callback: async () => {
                await this.rebuildKnowledgeBase(true);
            },
        });

        this.addRibbonIcon("message-square", "Open vault coach", () => {
            void this.activateView();
        });

        this.addSettingTab(new VaultCoachSettingTab(this.app, this));
        this.registerVaultEvents();

        if (!this.knowledgeBase.isReady()) {
            await this.rebuildKnowledgeBase(false);
        } else if (this.vectorIndexDirty && this.settings.enableVectorRetrieval) {
            await this.rebuildVectorIndexOnly(false);
        }

        this.app.workspace.onLayoutReady(() => {
            if (this.settings.openInRightSidebarOnStartup) {
                void this.activateView();
            }
        });
    }

    onunload(): void {
        this.clearAutoIndexTimers();
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            (await this.loadData()) as Partial<VaultCoachSettings>,
        );
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    markKnowledgeBaseDirty(): void {
        this.knowledgeBaseDirty = true;
        this.vectorIndexDirty = true;
        this.refreshAllViews();
    }

    isKnowledgeBaseDirty(): boolean {
        return this.knowledgeBaseDirty || this.vectorIndexDirty;
    }

    getKnowledgeBaseStats(): KnowledgeBaseStats {
        return this.knowledgeBase.getStats();
    }

    getVectorIndexStats(): VectorIndexStats {
        return this.ragEngine.getVectorIndexStats();
    }

    getKnowledgeScopeDescription(): string {
        const stats: KnowledgeBaseStats = this.getKnowledgeBaseStats();
        return stats.scopeDescription;
    }

    getRuntimeRetrievalMode(): RetrievalMode {
        return this.runtimeRetrievalMode;
    }

    setRuntimeRetrievalMode(mode: RetrievalMode): void {
        this.runtimeRetrievalMode = mode;
        this.refreshAllViews();
    }

    getMessages(): ChatMessage[] {
        return this.messages;
    }

    // 新增：供视图头部展示当前长期记忆数量。
    getMemoryCount(): number {
        return this.memories.length;
    }

    // 新增：发送前先持久化用户消息，确保异常中断时对话不会丢。
    async appendUserMessage(text: string): Promise<void> {
        this.messages.push({
            role: "user",
            text,
            createdAt: Date.now(),
        });
        this.trimMessages();
        await this.persistRuntimeState();
    }

    addAssistantMessage(text: string, sources: AnswerSource[]): void {
        this.messages.push({
            role: "assistant",
            text,
            createdAt: Date.now(),
            sources,
        });
        this.trimMessages();
    }

    resetConversation(): void {
        this.messages = [
            {
                role: "assistant",
                text: this.settings.defaultGreeting || `# 你好\n\n我是 ${this.settings.assistantName}。`,
                createdAt: Date.now(),
            },
        ];
        void this.persistRuntimeState();
    }

    refreshAllViews(): void {
        const leaves: WorkspaceLeaf[] = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH);
        for (const leaf of leaves) {
            const view = leaf.view;
            if (view instanceof VaultCoachView) {
                view.refresh();
            }
        }
    }

    async rebuildKnowledgeBase(showNotice: boolean): Promise<void> {
        try {
            const textSyncResult: KnowledgeBaseSyncResult = await this.knowledgeBase.rebuildIndexDetailed();
            const textStats: KnowledgeBaseStats = textSyncResult.stats;

            let vectorStats: VectorIndexStats = this.ragEngine.getVectorIndexStats();
            let vectorBuildWarning = "";

            try {
                vectorStats = await this.ragEngine.rebuildVectorIndex();
                this.vectorIndexDirty = false;
            } catch (vectorError: unknown) {
                console.error("[VaultCoach] 向量索引建立失败，将回退到关键词检索。", vectorError);
                vectorBuildWarning = "向量索引建立失败，已自动回退到关键词检索。";
                this.vectorIndexDirty = true;
            }

            this.knowledgeBaseDirty = false;
            await this.persistKnowledgeBaseSnapshot();
            this.refreshAllViews();

            if (showNotice) {
                const vectorInfo: string = this.settings.enableVectorRetrieval
                    ? `，向量数 ${vectorStats.vectorCount}`
                    : "";
                const message: string = `索引完成：${textStats.fileCount} 个文件，${textStats.chunkCount} 个片段${vectorInfo}。`;
                new Notice(vectorBuildWarning.length > 0 ? `${message} ${vectorBuildWarning}` : message);
            }
        } catch (error: unknown) {
            console.error("[VaultCoach] 重建索引失败", error);
            if (showNotice) {
                new Notice("重建索引失败，请打开开发者控制台查看错误信息。");
            }
        }
    }

    async ensureKnowledgeBaseReady(): Promise<void> {
        if (!this.knowledgeBase.isReady() || this.knowledgeBaseDirty) {
            await this.rebuildKnowledgeBase(false);
            return;
        }

        if (this.vectorIndexDirty && this.settings.enableVectorRetrieval) {
            await this.rebuildVectorIndexOnly(false);
        }
    }

    async activateView(): Promise<void> {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_VAULT_COACH)[0] ?? null;

        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            if (!leaf) {
                new Notice("Cannot create a new view");
                return;
            }

            await leaf.setViewState({
                type: VIEW_TYPE_VAULT_COACH,
                active: true,
            });
        }

        await workspace.revealLeaf(leaf);
    }

    // 新增：视图发送消息时调用，内部负责流式生成、记忆更新与持久化。
    async streamAssistantTurn(userText: string, handlers?: StreamHandlers): Promise<AssistantAnswer> {
        await this.ensureKnowledgeBaseReady();

        const memoryContext: string = this.buildMemoryContext(userText);
        const answer: AssistantAnswer = await this.ragEngine.streamAnswerQuestion(
            userText,
            this.messages,
            this.getKnowledgeScopeDescription(),
            memoryContext,
            handlers,
        );

        this.addAssistantMessage(answer.text, answer.sources);
        await this.updateLongTermMemory(userText, answer.text);
        await this.persistRuntimeState();

        return answer;
    }

    async openSource(source: AnswerSource): Promise<void> {
        const activeFilePath: string = this.app.workspace.getActiveFile()?.path ?? "";
        const linkTarget: string = source.heading
            ? `${source.filePath}#${source.heading}`
            : source.filePath;

        await this.app.workspace.openLinkText(linkTarget, activeFilePath, false);
    }

    private registerVaultEvents(): void {
        const queuePath = (path: string): void => {
            if (!this.isMarkdownPath(path)) {
                return;
            }

            this.pendingChangedMarkdownPaths.add(path);
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
            this.refreshAllViews();
            this.scheduleAutoIndexSync();
        };

        this.registerEvent(this.app.vault.on("create", (file: TAbstractFile) => {
            queuePath(file.path);
        }));

        this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {
            queuePath(file.path);
        }));

        this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
            queuePath(file.path);
        }));

        this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
            queuePath(oldPath);
            queuePath(file.path);
        }));
    }

    // 新增：当累计变更达到阈值或等待时间到达上限时自动触发增量同步。
    private scheduleAutoIndexSync(): void {
        if (!this.settings.enableAutoIndexSync) {
            return;
        }

        if (this.pendingChangedMarkdownPaths.size >= this.settings.autoIndexFileThreshold) {
            void this.flushPendingKnowledgeBaseSync(false);
            return;
        }

        if (this.autoIndexDebounceTimer !== null) {
            window.clearTimeout(this.autoIndexDebounceTimer);
        }

        this.autoIndexDebounceTimer = window.setTimeout(() => {
            void this.flushPendingKnowledgeBaseSync(false);
        }, this.settings.autoIndexDebounceMs);

        if (this.autoIndexMaxWaitTimer === null) {
            this.autoIndexMaxWaitTimer = window.setTimeout(() => {
                void this.flushPendingKnowledgeBaseSync(false);
            }, this.settings.autoIndexMaxWaitMs);
        }
    }

    // 新增：对 pending 文件执行真正的增量同步，并只重算变更 chunk 的 embedding。
    private async flushPendingKnowledgeBaseSync(showNotice: boolean): Promise<void> {
        if (this.isSyncingKnowledgeBase) {
            return;
        }

        const filePaths: string[] = Array.from(this.pendingChangedMarkdownPaths);
        if (filePaths.length === 0) {
            return;
        }

        this.isSyncingKnowledgeBase = true;
        this.pendingChangedMarkdownPaths.clear();
        this.clearAutoIndexTimers();

        try {
            if (!this.knowledgeBase.isReady()) {
                await this.rebuildKnowledgeBase(showNotice);
                return;
            }

            const syncResult: KnowledgeBaseSyncResult = await this.knowledgeBase.syncChangedFiles(filePaths);
            await this.ragEngine.syncVectorIndex(syncResult);

            this.lastAutoIndexAt = Date.now();
            this.knowledgeBaseDirty = false;
            this.vectorIndexDirty = false;

            await this.persistKnowledgeBaseSnapshot();
            await this.persistRuntimeState();
            this.refreshAllViews();

            if (showNotice) {
                new Notice(`增量同步完成：${syncResult.affectedFiles.length} 个文件变更已处理。`);
            }
        } catch (error: unknown) {
            console.error("[VaultCoach] 自动增量同步失败", error);
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
        } finally {
            this.isSyncingKnowledgeBase = false;
        }
    }

    private async rebuildVectorIndexOnly(showNotice: boolean): Promise<void> {
        try {
            const vectorStats: VectorIndexStats = await this.ragEngine.rebuildVectorIndex();
            this.vectorIndexDirty = false;
            this.knowledgeBaseDirty = false;
            await this.persistKnowledgeBaseSnapshot();
            this.refreshAllViews();

            if (showNotice) {
                new Notice(`向量索引完成：${vectorStats.vectorCount} 条向量。`);
            }
        } catch (error: unknown) {
            console.error("[VaultCoach] 向量索引重建失败", error);
            this.vectorIndexDirty = true;
            if (showNotice) {
                new Notice("向量索引重建失败，请打开开发者控制台查看错误信息。");
            }
        }
    }

    private async restorePersistentState(): Promise<void> {
        const state: PersistedPluginState | null = await this.persistentStore.loadRuntimeState();
        if (!state) {
            return;
        }

        this.messages = state.messages ?? [];
        this.memories = state.memories ?? [];
        this.lastAutoIndexAt = state.lastAutoIndexAt ?? null;
        this.trimMessages();
        this.trimMemories();
    }

    private async restoreKnowledgeBaseSnapshot(): Promise<void> {
        const snapshot: KnowledgeBaseSnapshot | null = await this.persistentStore.loadKnowledgeBaseSnapshot();
        if (!snapshot) {
            return;
        }

        const textSignatureMatches: boolean = snapshot.settingsSignature === this.knowledgeBase.getSettingsSignature();
        if (!textSignatureMatches) {
            this.knowledgeBaseDirty = true;
            this.vectorIndexDirty = true;
            return;
        }

        this.knowledgeBase.loadFromSnapshot(snapshot);
        this.ragEngine.hydrateVectorStats(snapshot.vectorStats);
        this.knowledgeBaseDirty = false;

        const currentEmbeddingModel: string | null = this.settings.enableVectorRetrieval
            ? this.settings.embeddingModel.trim()
            : null;

        if (snapshot.embeddingModel !== currentEmbeddingModel) {
            this.knowledgeBase.clearVectorIndex();
            this.ragEngine.hydrateVectorStats({
                ready: false,
                vectorCount: 0,
                dimension: null,
                lastBuiltAt: null,
            });
            this.vectorIndexDirty = this.settings.enableVectorRetrieval;
        } else {
            this.vectorIndexDirty = false;
        }
    }

    private async persistRuntimeState(): Promise<void> {
        const state: PersistedPluginState = {
            messages: [...this.messages],
            memories: [...this.memories],
            lastAutoIndexAt: this.lastAutoIndexAt,
        };
        await this.persistentStore.saveRuntimeState(state);
    }

    private async persistKnowledgeBaseSnapshot(): Promise<void> {
        const snapshot: KnowledgeBaseSnapshot = {
            version: 1,
            settingsSignature: this.knowledgeBase.getSettingsSignature(),
            embeddingModel: this.settings.enableVectorRetrieval
                ? this.settings.embeddingModel.trim()
                : null,
            stats: this.knowledgeBase.getStats(),
            vectorStats: this.ragEngine.getVectorIndexStats(),
            chunks: this.knowledgeBase.getAllChunks(),
            embeddings: this.knowledgeBase.getEmbeddingSnapshot(),
            files: this.knowledgeBase.getFileRecords(),
        };
        await this.persistentStore.saveKnowledgeBaseSnapshot(snapshot);
    }

    // 新增：从本地长期记忆中检索与当前问题最相关的条目，并注入到 prompt。
    private buildMemoryContext(query: string): string {
        if (!this.settings.enableLongTermMemory || this.memories.length === 0) {
            return "";
        }

        const hits: MemorySearchHit[] = this.searchMemories(query, this.settings.memoryTopK);
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

    // 新增：回答结束后抽取长期记忆并做本地去重、更新和裁剪。
    private async updateLongTermMemory(userText: string, assistantText: string): Promise<void> {
        if (!this.settings.enableLongTermMemory) {
            return;
        }

        const memoryStatements: string[] = await this.ragEngine.extractMemoryStatements(
            userText,
            assistantText,
            this.messages,
        );

        if (memoryStatements.length === 0) {
            return;
        }

        const now: number = Date.now();
        for (const statement of memoryStatements) {
            const normalizedStatement: string = this.normalizeMemoryText(statement);
            if (normalizedStatement.length === 0) {
                continue;
            }

            const existing: MemoryItem | undefined = this.memories.find((item: MemoryItem) => {
                return this.normalizeMemoryText(item.text) === normalizedStatement;
            });

            if (existing) {
                existing.text = statement.trim();
                existing.updatedAt = now;
                existing.lastAccessedAt = now;
                continue;
            }

            this.memories.unshift({
                id: this.createMemoryId(normalizedStatement),
                text: statement.trim(),
                createdAt: now,
                updatedAt: now,
                lastAccessedAt: now,
            });
        }

        this.trimMemories();
    }

    private searchMemories(query: string, limit: number): MemorySearchHit[] {
        const normalizedQuery: string = this.normalizeMemoryText(query);
        const queryTokens: string[] = Array.from(new Set(this.tokenize(query)));
        const hits: MemorySearchHit[] = [];

        for (const item of this.memories) {
            const normalizedText: string = this.normalizeMemoryText(item.text);
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

    private trimMessages(): void {
        const maxMessages: number = Math.max(1, this.settings.maxConversationMessages);
        if (this.messages.length <= maxMessages) {
            return;
        }

        const greeting: ChatMessage | undefined = this.messages.find((message: ChatMessage) => message.role === "assistant");
        const tail: ChatMessage[] = this.messages.slice(-maxMessages);

        if (greeting && !tail.includes(greeting)) {
            this.messages = [greeting, ...tail.slice(1)];
            return;
        }

        this.messages = tail;
    }

    private trimMemories(): void {
        const maxItems: number = Math.max(1, this.settings.memoryMaxItems);
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

    private clearAutoIndexTimers(): void {
        if (this.autoIndexDebounceTimer !== null) {
            window.clearTimeout(this.autoIndexDebounceTimer);
            this.autoIndexDebounceTimer = null;
        }

        if (this.autoIndexMaxWaitTimer !== null) {
            window.clearTimeout(this.autoIndexMaxWaitTimer);
            this.autoIndexMaxWaitTimer = null;
        }
    }

    private normalizeMemoryText(text: string): string {
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

    private createMemoryId(text: string): string {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `mem_${(hash >>> 0).toString(16)}`;
    }

    private isMarkdownPath(path: string): boolean {
        return path.toLowerCase().endsWith(".md");
    }
}