import type { TranslationKey } from "../i18n";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

export function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function formatGenerationDuration(durationMs: number, t: TranslateFn): string {
    const seconds: number = Math.max(0, Math.floor(durationMs / 1000));
    return t("view.generationDuration", { seconds });
}

export function formatDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString([], {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function createShortErrorMessage(error: unknown): string {
    const message: string = error instanceof Error ? error.message : String(error);
    const normalizedMessage: string = message.replace(/\s+/g, " ").trim();

    if (normalizedMessage.length <= 180) {
        return normalizedMessage;
    }

    return `${normalizedMessage.slice(0, 177)}...`;
}
