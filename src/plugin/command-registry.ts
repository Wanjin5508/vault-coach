import { Notice, type Plugin } from "obsidian";
import type { TranslationKey } from "../i18n";
import type { VaultCoachPluginApi } from "../presentation/plugin-api";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

/**
 * 注册 Obsidian 命令面板命令。
 */
export function registerVaultCoachCommands(host: Plugin, api: VaultCoachPluginApi, t: TranslateFn): void {
    host.addCommand({
        id: "open-view",
        name: t("command.openView"),
        callback: async () => {
            await api.activateView();
        },
    });

    host.addCommand({
        id: "reset-conversation",
        name: t("command.resetConversation"),
        callback: () => {
            api.resetConversation();
            api.refreshAllViews();
            new Notice(t("notice.resetSuccess"));
        },
    });

    host.addCommand({
        id: "rebuild-knowledge-index",
        name: t("command.rebuildKnowledgeIndex"),
        callback: async () => {
            await api.rebuildKnowledgeBase(true);
        },
    });

    host.addCommand({
        id: "stop-knowledge-index",
        name: t("command.stopKnowledgeIndex"),
        callback: () => {
            api.abortKnowledgeIndexBuild(true);
        },
    });

    host.addCommand({
        id: "clear-knowledge-index",
        name: t("command.clearKnowledgeIndex"),
        callback: async () => {
            await api.clearKnowledgeIndex(true);
        },
    });
}

/**
 * 注册侧边栏按钮。
 */
export function registerVaultCoachRibbon(host: Plugin, api: VaultCoachPluginApi, t: TranslateFn): void {
    host.addRibbonIcon("message-square", t("ribbon.openVaultCoach"), () => {
        void api.activateView();
    });
}
