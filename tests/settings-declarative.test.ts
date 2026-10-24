import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { createDefaultSettings, VaultCoachSettingTab } from "../src/settings";
import { translate } from "../src/i18n";
import type { VaultCoachPluginApi } from "../src/presentation/plugin-api";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";

function createApi() {
    const saveSettings = vi.fn(async () => undefined);
    const refreshAllViews = vi.fn();
    const setRuntimeRetrievalPreference = vi.fn();
    let advancedSettingsExpanded = false;
    const markKnowledgeBaseDirty = vi.fn();
    const markVectorIndexDirty = vi.fn();
    const updateKnowledgeScope = vi.fn(async (selection: { kind: "whole-vault" } | { kind: "folder"; path: string }) => {
        if (selection.kind === "whole-vault") {
            api.settings.knowledgeScopeMode = "wholeVault";
            return;
        }
        api.settings.knowledgeScopeMode = "specificFolder";
        api.settings.knowledgeFolder = selection.path;
    });
    const api = {
        settings: createDefaultSettings(),
        saveSettings,
        refreshAllViews,
        setRuntimeRetrievalPreference,
        getSettingsUiPreferences: () => ({ advancedSettingsExpanded }),
        setSettingsUiPreferences: vi.fn(async (preferences: { advancedSettingsExpanded: boolean }) => {
            advancedSettingsExpanded = preferences.advancedSettingsExpanded;
        }),
        getSettingsMigrationWarnings: () => [],
        hasCloudApiKeySecret: () => true,
        getVectorIndexStats: () => ({ ready: false, vectorCount: 0, dimension: null, lastBuiltAt: null }),
        getLocalAiStatus: () => ({
            role: "embedding" as const,
            phase: "not-installed" as const,
            progress: null,
            message: null,
            cached: false,
            backend: "wasm" as const,
        }),
        getKnowledgeScopeSelection: () => api.settings.knowledgeScopeMode === "wholeVault"
            ? { kind: "whole-vault" as const }
            : { kind: "folder" as const, path: api.settings.knowledgeFolder },
        listKnowledgeScopeOptions: () => [{
            id: "whole-vault" as const,
            kind: "whole-vault" as const,
            depth: 0 as const,
            selected: api.settings.knowledgeScopeMode === "wholeVault",
        }],
        updateKnowledgeScope,
        markKnowledgeBaseDirty,
        markVectorIndexDirty,
    } as unknown as VaultCoachPluginApi;
    return {
        api,
        saveSettings,
        refreshAllViews,
        setRuntimeRetrievalPreference,
        expandAdvanced: () => { advancedSettingsExpanded = true; },
        markKnowledgeBaseDirty,
        markVectorIndexDirty,
        updateKnowledgeScope,
    };
}

function getControlKeys(tab: VaultCoachSettingTab): string[] {
    return getFlatDefinitions(tab).flatMap((definition) => {
        const control = "control" in definition ? definition.control : undefined;
        return control?.key ? [control.key] : [];
    });
}

function getFlatDefinitions(tab: VaultCoachSettingTab): SettingGroupItem[] {
    const flattened: SettingGroupItem[] = [];
    const visit = (definitions: SettingDefinitionItem[]): void => {
        for (const definition of definitions) {
            if ("type" in definition && (definition.type === "group" || definition.type === "list")) {
                flattened.push(...(definition.items ?? []));
                continue;
            }
            if (!("type" in definition) || definition.type !== "page") {
                flattened.push(definition as SettingGroupItem);
            }
        }
    };
    visit(tab.getSettingDefinitions());
    return flattened;
}

describe("VaultCoachSettingTab declarative settings", () => {
    it("indexes every persisted setting while retaining provider-specific fields", () => {
        const { api, expandAdvanced } = createApi();
        const tab = new VaultCoachSettingTab(new App(), {} as never, api);
        expandAdvanced();
        const defaultControlKeys = getControlKeys(tab);

        api.settings.modelProvider = "openai-compatible";
        api.settings.embeddingProvider = "openai-compatible";
        const cloudControlKeys = getControlKeys(tab);
        const indexedKeys = new Set([...defaultControlKeys, ...cloudControlKeys]);

        for (const key of Object.keys(createDefaultSettings())) {
            if (key === "defaultRetrievalMode") continue;
            if (key === "knowledgeScopeMode" || key === "knowledgeFolder") {
                expect(getFlatDefinitions(tab).some((definition) => {
                    return "name" in definition && definition.name === translate("settings.scope.unified.name");
                })).toBe(true);
            } else if (key === "cloudApiKeySecretName") {
                expect(getFlatDefinitions(tab).some((definition) => {
                    return "name" in definition && definition.name === translate("settings.cloudApiKey.name");
                })).toBe(true);
            } else {
                expect(indexedKeys.has(key)).toBe(true);
            }
        }
    });

    it("keeps basic categories visible and reveals advanced categories from one registry", () => {
        const { api, expandAdvanced } = createApi();
        const tab = new VaultCoachSettingTab(new App(), {} as never, api);

        const collapsed = tab.getSettingDefinitions();
        expect(collapsed.filter((definition) => "type" in definition && definition.type === "group"))
            .toHaveLength(3);
        expect(getFlatDefinitions(tab).filter((definition) => "name" in definition
            && definition.name === translate("settings.scope.unified.name"))).toHaveLength(1);
        expect(getControlKeys(tab)).not.toContain("knowledgeScopeMode");
        expect(getControlKeys(tab)).not.toContain("knowledgeFolder");

        const disclosure = collapsed.find((definition) => "name" in definition
            && definition.name === translate("settings.advancedDisclosure.title"));
        expect(disclosure && "aliases" in disclosure ? disclosure.aliases : []).toEqual(expect.arrayContaining([
            "embedding",
            "检索",
            "rerank",
            "索引",
        ]));

        expandAdvanced();
        const expandedGroups = tab.getSettingDefinitions()
            .filter((definition) => "type" in definition && definition.type === "group");
        expect(expandedGroups).toHaveLength(10);
    });

    it("keeps imperative normalization and index invalidation behind declarative controls", async () => {
        const { api, markKnowledgeBaseDirty, markVectorIndexDirty, saveSettings } = createApi();
        const tab = new VaultCoachSettingTab(new App(), {} as never, api);

        await tab.setControlValue("chunkSize", "not-a-number");
        await tab.setControlValue("enableVectorRetrieval", false);

        expect(api.settings.chunkSize).toBe(createDefaultSettings().chunkSize);
        expect(api.settings.enableVectorRetrieval).toBe(false);
        expect(markKnowledgeBaseDirty).toHaveBeenCalledOnce();
        expect(markVectorIndexDirty).toHaveBeenCalledOnce();
        expect(saveSettings).toHaveBeenCalledTimes(2);
    });

    it("shows built-in runtime controls only for the built-in embedding provider", () => {
        const { api, expandAdvanced } = createApi();
        const tab = new VaultCoachSettingTab(new App(), {} as never, api);
        expandAdvanced();
        expect(getFlatDefinitions(tab).some((definition) => "name" in definition
            && definition.name === translate("settings.builtinEmbedding.runtime.name"))).toBe(false);

        api.settings.embeddingProvider = "builtin";
        expect(getFlatDefinitions(tab).some((definition) => "name" in definition
            && definition.name === translate("settings.builtinEmbedding.runtime.name"))).toBe(true);
    });

    it("keeps Learning Map automatic relations display-only and clamps their threshold", async () => {
        const { api, refreshAllViews, saveSettings } = createApi();
        const tab = new VaultCoachSettingTab(new App(), {} as never, api);

        await tab.setControlValue("learningMapAutoRelationsEnabled", false);
        await tab.setControlValue("learningMapAutoModelThreshold", "0.2");

        expect(api.settings.learningMapAutoRelationsEnabled).toBe(false);
        expect(api.settings.learningMapAutoModelThreshold).toBe(0.7);
        expect(refreshAllViews).toHaveBeenCalledTimes(2);
        expect(saveSettings).toHaveBeenCalledTimes(2);
    });
});
