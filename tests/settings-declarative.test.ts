import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { createDefaultSettings, VaultCoachSettingTab } from "../src/settings";
import { translate } from "../src/i18n";
import type { VaultCoachPluginApi } from "../src/presentation/plugin-api";

function createApi() {
    const saveSettings = vi.fn(async () => undefined);
    const refreshAllViews = vi.fn();
    const setRuntimeRetrievalMode = vi.fn();
    const markKnowledgeBaseDirty = vi.fn();
    const markVectorIndexDirty = vi.fn();
    const api = {
        settings: createDefaultSettings(),
        saveSettings,
        refreshAllViews,
        setRuntimeRetrievalMode,
        markKnowledgeBaseDirty,
        markVectorIndexDirty,
    } as unknown as VaultCoachPluginApi;
    return {
        api,
        saveSettings,
        refreshAllViews,
        setRuntimeRetrievalMode,
        markKnowledgeBaseDirty,
        markVectorIndexDirty,
    };
}

function getControlKeys(tab: VaultCoachSettingTab): string[] {
    return tab.getSettingDefinitions().flatMap((definition) => {
        const control = (definition as { control?: { key?: string } }).control;
        return control?.key ? [control.key] : [];
    });
}

describe("VaultCoachSettingTab declarative settings", () => {
    it("indexes every persisted setting while retaining provider-specific fields", () => {
        const { api } = createApi();
        const tab = new VaultCoachSettingTab(new App(), {} as never, api);
        const defaultControlKeys = getControlKeys(tab);

        api.settings.modelProvider = "openai-compatible";
        api.settings.embeddingProvider = "openai-compatible";
        const cloudControlKeys = getControlKeys(tab);
        const indexedKeys = new Set([...defaultControlKeys, ...cloudControlKeys]);

        for (const key of Object.keys(createDefaultSettings())) {
            if (key === "cloudApiKeySecretName") {
                expect(tab.getSettingDefinitions().some((definition) => {
                    return "name" in definition && definition.name === translate("settings.cloudApiKey.name");
                })).toBe(true);
            } else {
                expect(indexedKeys.has(key)).toBe(true);
            }
        }
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
});
