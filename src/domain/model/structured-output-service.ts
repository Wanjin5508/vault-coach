import type { JsonGenerationGateway } from "./json-generation-gateway";
import type { LocalChatMessage } from "./model-types";

const DEFAULT_JSON_REPAIR_INSTRUCTIONS: readonly string[] = [
    "你是一个严格 JSON 修复器。",
    "你的任务是把用户提供的模型输出修复为可以被 JSON.parse 解析的 JSON。",
    "只输出 JSON 对象，不要输出 Markdown、解释或代码块。",
    "不要新增、删除或改写字段含义。",
    "修复未转义双引号、字符串内部原始换行、尾随逗号等语法问题。",
];

/**
 * 尽量从模型输出中解析 JSON 对象。
 *
 * 兼容被 Markdown 代码块包裹或前后带解释文本的模型输出。
 */
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

/**
 * 调用模型生成 JSON，并在第一次解析失败时让模型按 schema 修复。
 */
export async function generateParsedJsonAnswer<T>(
    gateway: JsonGenerationGateway,
    messages: LocalChatMessage[],
    temperature: number,
    schemaDescription: string,
    taskLabel: string,
    abortSignal?: AbortSignal,
    repairInstructions: readonly string[] = DEFAULT_JSON_REPAIR_INSTRUCTIONS,
): Promise<T> {
    abortSignal?.throwIfAborted();
    const rawJson: string = await gateway.generateJsonAnswer(messages, temperature);
    abortSignal?.throwIfAborted();

    try {
        return parseJsonObject(rawJson) as T;
    } catch (parseError: unknown) {
        console.warn(`[VaultCoach] ${taskLabel}返回的 JSON 无法直接解析，尝试让模型修复。`, parseError);
    }

    const repairMessages: LocalChatMessage[] = [
        {
            role: "system",
            content: repairInstructions.join("\n"),
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

    abortSignal?.throwIfAborted();
    const repairedJson: string = await gateway.generateJsonAnswer(repairMessages, 0);
    abortSignal?.throwIfAborted();

    try {
        return parseJsonObject(repairedJson) as T;
    } catch (repairError: unknown) {
        console.error(`[VaultCoach] ${taskLabel}的 JSON 修复仍然失败。`, repairError);
        throw new Error(`${taskLabel}失败：模型返回的 JSON 无法解析，请重试或换用更稳定的聊天模型。`);
    }
}
