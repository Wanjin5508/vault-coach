import { Notice } from "obsidian";
import type { TranslationKey } from "../i18n";
import type { VaultCoachPluginInstance } from "../plugin-api";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/**
 * 注册 Obsidian 命令面板命令。
 */
export function registerVaultCoachCommands(plugin: VaultCoachPluginInstance, t: TranslateFn): void {
    plugin.addCommand({
        id: "open-view",
        name: t("command.openView"),
        callback: async () => {
            await plugin.activateView();
        },
    });

    plugin.addCommand({
        id: "reset-conversation",
        name: t("command.resetConversation"),
        callback: () => {
            plugin.resetConversation();
            plugin.refreshAllViews();
            new Notice(t("notice.resetSuccess"));
        },
    });

    plugin.addCommand({
        id: "rebuild-knowledge-index",
        name: t("command.rebuildKnowledgeIndex"),
        callback: async () => {
            await plugin.rebuildKnowledgeBase(true);
        },
    });

    plugin.addCommand({
        id: "stop-knowledge-index",
        name: t("command.stopKnowledgeIndex"),
        callback: () => {
            plugin.abortKnowledgeIndexBuild(true);
        },
    });

    plugin.addCommand({
        id: "clear-knowledge-index",
        name: t("command.clearKnowledgeIndex"),
        callback: async () => {
            await plugin.clearKnowledgeIndex(true);
        },
    });
}

/**
 * 注册侧边栏按钮。
 */
export function registerVaultCoachRibbon(plugin: VaultCoachPluginInstance, t: TranslateFn): void {
    plugin.addRibbonIcon("message-square", t("ribbon.openVaultCoach"), () => {
        void plugin.activateView();
    });
}
