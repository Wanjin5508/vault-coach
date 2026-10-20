import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migrateSettings } from "../../../src/app/config/settings-migrations";
import { FutureSettingsSchemaError, SettingsRepository } from "../../../src/app/config/settings-repository";
import { CURRENT_SETTINGS_SCHEMA_VERSION } from "../../../src/app/config/settings-schema";

function fixture(name: string): unknown {
    return JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/settings", name), "utf8"));
}

describe("settings migration", () => {
    it("maps a legacy retrieval mode while preserving local provider choices", () => {
        const result = migrateSettings(fixture("legacy-local.json"));
        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.source).toBe("legacy");
        expect(result.settings).toMatchObject({
            knowledgeFolder: "Research Notes",
            chatModel: "qwen2.5:7b",
            embeddingModel: "nomic-embed-text",
            retrievalPreference: "vector",
            chunkSize: 1337,
            enableRerank: false,
        });
    });

    it("preserves cloud provider fields, secret references, false and zero", () => {
        const result = migrateSettings(fixture("legacy-cloud.json"));
        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.settings.cloudApiKeySecretName).toBe("vault-coach-team-key");
        expect(result.settings.generationTemperature).toBe(0);
        expect(result.settings.enableQueryRewrite).toBe(false);
        expect(result.settings.retrievalPreference).toBe("hybrid");
    });

    it("preserves independent chat and embedding providers", () => {
        const result = migrateSettings(fixture("legacy-mixed.json"));
        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.settings).toMatchObject({
            modelProvider: "openai-compatible",
            cloudChatModel: "cloud-chat",
            embeddingProvider: "ollama",
            embeddingModel: "local-embedding",
            retrievalPreference: "keyword",
            keywordSearchTopK: 31,
            enableVectorRetrieval: false,
        });
    });

    it("round-trips an existing deep knowledge folder without a schema bump", async () => {
        const migrated = migrateSettings(fixture("legacy-local.json"));
        expect(migrated.status).toBe("ready");
        if (migrated.status !== "ready") return;
        const writes: unknown[] = [];
        const repository = new SettingsRepository({
            loadData: async () => ({
                ...migrated.settings,
                settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
                knowledgeScopeMode: "specificFolder",
                knowledgeFolder: "研究/课程/2025/强化学习",
            }),
            saveData: async (data) => { writes.push(data); },
        });

        const result = await repository.load();
        await repository.save(result.settings);

        expect(result.settings.knowledgeFolder).toBe("研究/课程/2025/强化学习");
        expect(writes.at(-1)).toMatchObject({
            settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
            knowledgeFolder: "研究/课程/2025/强化学习",
        });
    });

    it("falls back field by field and returns non-sensitive warnings", () => {
        const result = migrateSettings(fixture("invalid-values.json"));
        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.settings.chunkSize).toBeGreaterThan(0);
        expect(result.settings.modelProvider).toBe("ollama");
        expect(result.settings.knowledgeFolder).toBe("");
        expect(result.warnings.map((warning) => warning.field)).toEqual(expect.arrayContaining([
            "chunkSize", "generationTemperature", "modelProvider", "enableRerank",
        ]));
        expect(JSON.stringify(result.warnings)).not.toContain("example.invalid");
    });

    it("uses auto only for a new installation", () => {
        const result = migrateSettings(null);
        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.source).toBe("new-install");
        expect(result.settings.retrievalPreference).toBe("auto");
    });

    it("does not classify malformed stored data as a new installation", () => {
        const result = migrateSettings("corrupt");
        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.source).toBe("legacy");
        expect(result.warnings[0]?.code).toBe("invalid-type");
    });

    it("refuses to overwrite a future schema", async () => {
        const saveData = vi.fn(async () => undefined);
        const repository = new SettingsRepository({
            loadData: async () => fixture("future-schema.json"),
            saveData,
        });
        await expect(repository.load()).rejects.toBeInstanceOf(FutureSettingsSchemaError);
        expect(saveData).not.toHaveBeenCalled();
    });

    it("serializes migrations and preserves unknown fields", async () => {
        const writes: unknown[] = [];
        const repository = new SettingsRepository({
            loadData: async () => ({ ...fixture("legacy-local.json") as object, extensionMetadata: { keep: true } }),
            saveData: async (data) => { writes.push(data); },
        });
        const result = await repository.load();
        await Promise.all([
            repository.save({ ...result.settings, assistantName: "First" }),
            repository.save({ ...result.settings, assistantName: "Last" }),
        ]);
        expect(writes).toHaveLength(3);
        expect(writes.at(-1)).toMatchObject({
            settingsSchemaVersion: 1,
            assistantName: "Last",
            extensionMetadata: { keep: true },
        });
    });

    it("keeps the save queue usable after a storage failure", async () => {
        const saveData = vi.fn()
            .mockRejectedValueOnce(new Error("disk unavailable"))
            .mockResolvedValue(undefined);
        const repository = new SettingsRepository({ loadData: async () => null, saveData });
        const result = migrateSettings(null);
        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;

        await expect(repository.save(result.settings)).rejects.toThrow("disk unavailable");
        await expect(repository.save({ ...result.settings, assistantName: "Recovered" })).resolves.toBeUndefined();
        expect(saveData).toHaveBeenCalledTimes(2);
    });

    it("rolls back the in-memory UI preference when persistence fails", async () => {
        const saveData = vi.fn(async () => undefined);
        const repository = new SettingsRepository({ loadData: async () => null, saveData });
        const result = await repository.load();
        saveData.mockRejectedValueOnce(new Error("disk unavailable"));

        await expect(repository.setUiPreferences(result.settings, { advancedSettingsExpanded: true }))
            .rejects.toThrow("disk unavailable");

        expect(repository.getUiPreferences()).toEqual({ advancedSettingsExpanded: false });
    });

    it("keeps an existing expanded advanced preference after upgrade", async () => {
        const migrated = migrateSettings(fixture("legacy-local.json"));
        expect(migrated.status).toBe("ready");
        if (migrated.status !== "ready") return;
        const repository = new SettingsRepository({
            loadData: async () => ({
                ...migrated.settings,
                settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
                uiPreferences: { advancedSettingsExpanded: true },
            }),
            saveData: async () => undefined,
        });

        await repository.load();

        expect(repository.getUiPreferences()).toEqual({ advancedSettingsExpanded: true });
    });
});
