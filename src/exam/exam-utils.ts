import { LocalModelClient } from "../model-client";
import type { LocalChatMessage } from "../types";

export function throwIfAborted(abortSignal?: AbortSignal): void {
    if (!abortSignal?.aborted) {
        return;
    }

    throw new DOMException("VaultCoach exam generation was cancelled.", "AbortError");
}

export function clampNumber(value: unknown, min: number, max: number): number {
    const numericValue: number = typeof value === "number"
        ? value
        : (typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN);

    if (!Number.isFinite(numericValue)) {
        return min;
    }

    return Math.max(min, Math.min(max, numericValue));
}

export function normalizeWhitespace(value: unknown): string {
    if (typeof value === "string") {
        return value.replace(/\s+/g, " ").trim();
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value).replace(/\s+/g, " ").trim();
    }

    return "";
}

export function normalizeHeadingPath(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((part: unknown): part is string => typeof part === "string")
        .map((part: string) => normalizeWhitespace(part))
        .filter((part: string) => part.length > 0);
}

export function headingPathKey(headingPath: string[]): string {
    return headingPath.map((part: string) => normalizeWhitespace(part).toLowerCase()).join("\u0000");
}

export function headingPathMatches(candidate: string[], target: string[]): boolean {
    if (target.length === 0) {
        return candidate.length === 0;
    }

    if (candidate.length < target.length) {
        return false;
    }

    for (let index = 0; index < target.length; index += 1) {
        if (normalizeWhitespace(candidate[index] ?? "").toLowerCase() !== normalizeWhitespace(target[index] ?? "").toLowerCase()) {
            return false;
        }
    }

    return true;
}

export function stripInternalExamLabels(value: unknown): string {
    return normalizeWhitespace(value)
        .replace(/^(?:请)?(?:根据|基于|结合|参考)(?:上述|给定|以上|以下|下列|提供的)?(?:上下文|材料|片段|内容|文本)(?:中(?:的)?(?:内容|信息|描述|说明)?)?\s*[，,。.:：；;]?\s*/gi, "")
        .replace(/上下文\s*\d+/gi, "")
        .replace(/context\s*\d+/gi, "")
        .replace(/excerpt[_\s-]*id\s*[:：]?\s*E?\d+/gi, "")
        .replace(/SOURCE_PATH\s*[:：][^\n。；;]*/g, "")
        .replace(/SOURCE_CHUNK_IDS?\s*[:：][^\n。；;]*/gi, "")
        .replace(/HEADING\s*[:：][^\n。；;]*/g, "")
        .replace(/BLUEPRINT_ITEM\s*[:：][^\n。；;]*/gi, "")
        .replace(/\bE\d+\b/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/\s+([，。；：！？,.!?;:])/g, "$1")
        .trim();
}

export function parseJsonObject(rawText: string): unknown {
    const trimmedText: string = rawText.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();

    try {
        return JSON.parse(trimmedText) as unknown;
    } catch {
        const startIndex: number = trimmedText.indexOf("{");
        const endIndex: number = trimmedText.lastIndexOf("}");
        if (startIndex >= 0 && endIndex > startIndex) {
            return JSON.parse(trimmedText.slice(startIndex, endIndex + 1)) as unknown;
        }

        throw new Error("模型输出不是有效 JSON。");
    }
}

export async function generateParsedJsonAnswer<T>(
    client: LocalModelClient,
    messages: LocalChatMessage[],
    temperature: number,
    schemaDescription: string,
    taskLabel: string,
    abortSignal?: AbortSignal,
): Promise<T> {
    throwIfAborted(abortSignal);
    const rawJson: string = await client.generateJsonAnswer(messages, temperature);
    throwIfAborted(abortSignal);

    try {
        return parseJsonObject(rawJson) as T;
    } catch (parseError: unknown) {
        console.warn(`[VaultCoach] ${taskLabel}返回的 JSON 无法直接解析，尝试让模型修复。`, parseError);
    }

    const repairMessages: LocalChatMessage[] = [
        {
            role: "system",
            content: [
                "你是一个严格 JSON 修复器。",
                "你的任务是把用户提供的模型输出修复为可以被 JSON.parse 解析的 JSON。",
                "只输出 JSON 对象，不要输出 Markdown、解释或代码块。",
                "不要新增、删除或改写字段含义。",
                "修复未转义双引号、字符串内部原始换行、尾随逗号等语法问题。",
            ].join("\n"),
        },
        {
            role: "user",
            content: [
                `任务：${taskLabel}`,
                "",
                "目标 schema：",
                schemaDescription,
                "",
                "待修复的原始输出：",
                rawJson.length > 16000 ? `${rawJson.slice(0, 16000)}\n...` : rawJson,
            ].join("\n"),
        },
    ];

    throwIfAborted(abortSignal);
    const repairedJson: string = await client.generateJsonAnswer(repairMessages, 0);
    throwIfAborted(abortSignal);

    try {
        return parseJsonObject(repairedJson) as T;
    } catch (repairError: unknown) {
        console.error(`[VaultCoach] ${taskLabel}的 JSON 修复仍然失败。`, repairError);
        throw new Error(`${taskLabel}失败：模型返回的 JSON 无法解析，请重试或换用更稳定的聊天模型。`);
    }
}
