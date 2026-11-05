import type { QueryRewriteResult } from "../retrieval/retrieval-types";

export type UtilityOutputValidationCode =
    | "invalid-json"
    | "invalid-shape"
    | "unexpected-field"
    | "empty-value"
    | "limit-exceeded"
    | "duplicate-value";

export interface UtilityOutputLimits {
    rawJsonCharacters: number;
    rewrittenQueryCharacters: number;
    memoryStatements: number;
    memoryStatementCharacters: number;
}

export const DEFAULT_UTILITY_OUTPUT_LIMITS: Readonly<UtilityOutputLimits> = {
    rawJsonCharacters: 8_192,
    rewrittenQueryCharacters: 512,
    memoryStatements: 5,
    memoryStatementCharacters: 500,
};

export class UtilityOutputValidationError extends Error {
    constructor(readonly code: UtilityOutputValidationCode, message: string) {
        super(message);
        this.name = "UtilityOutputValidationError";
    }
}

/** M6.2 的 JSON 边界是严格对象；不接受 Markdown fence、解释文本或数组根节点。 */
export function parseUtilityJson(
    rawText: string,
    limits: Readonly<UtilityOutputLimits> = DEFAULT_UTILITY_OUTPUT_LIMITS,
): Record<string, unknown> {
    if (rawText.length > limits.rawJsonCharacters) {
        throw new UtilityOutputValidationError("limit-exceeded", "Utility JSON exceeds the output budget.");
    }
    let value: unknown;
    try {
        value = JSON.parse(rawText) as unknown;
    } catch {
        throw new UtilityOutputValidationError("invalid-json", "Utility output is not strict JSON.");
    }
    if (!isRecord(value)) {
        throw new UtilityOutputValidationError("invalid-shape", "Utility JSON must be an object.");
    }
    return value;
}

export function parseQueryRewriteOutput(
    rawText: string,
    originalQuery: string,
    limits: Readonly<UtilityOutputLimits> = DEFAULT_UTILITY_OUTPUT_LIMITS,
): QueryRewriteResult {
    return validateQueryRewritePayload(parseUtilityJson(rawText, limits), originalQuery, limits);
}

export function parseMemoryExtractionOutput(
    rawText: string,
    limits: Readonly<UtilityOutputLimits> = DEFAULT_UTILITY_OUTPUT_LIMITS,
): readonly string[] {
    return validateMemoryExtractionPayload(parseUtilityJson(rawText, limits), limits);
}

export function validateQueryRewritePayload(
    value: unknown,
    originalQuery: string,
    limits: Readonly<UtilityOutputLimits> = DEFAULT_UTILITY_OUTPUT_LIMITS,
): QueryRewriteResult {
    const record = requireExactObject(value, "rewritten_query");
    const rewrittenQuery = requireBoundedText(
        record.rewritten_query,
        limits.rewrittenQueryCharacters,
        "Rewritten query",
    );
    return {
        originalQuery,
        rewrittenQuery,
        useRewrite: rewrittenQuery !== originalQuery,
    };
}

export function validateMemoryExtractionPayload(
    value: unknown,
    limits: Readonly<UtilityOutputLimits> = DEFAULT_UTILITY_OUTPUT_LIMITS,
): readonly string[] {
    const record = requireExactObject(value, "memories");
    return validateMemoryStatements(record.memories, limits);
}

/** 对已经通过端口返回的结果再次做运行时校验，防止类型声明掩盖无效 provider 输出。 */
export function validateQueryRewriteResult(
    value: unknown,
    originalQuery: string,
    limits: Readonly<UtilityOutputLimits> = DEFAULT_UTILITY_OUTPUT_LIMITS,
): QueryRewriteResult {
    if (!isRecord(value)
        || value.originalQuery !== originalQuery
        || typeof value.rewrittenQuery !== "string"
        || typeof value.useRewrite !== "boolean") {
        throw new UtilityOutputValidationError("invalid-shape", "Query rewrite result does not match its request.");
    }
    if (!value.useRewrite) {
        if (value.rewrittenQuery !== originalQuery) {
            throw new UtilityOutputValidationError("invalid-shape", "Disabled rewrite must preserve the original query.");
        }
        return { originalQuery, rewrittenQuery: originalQuery, useRewrite: false };
    }
    const rewrittenQuery = requireBoundedText(
        value.rewrittenQuery,
        limits.rewrittenQueryCharacters,
        "Rewritten query",
    );
    if (rewrittenQuery === originalQuery) {
        throw new UtilityOutputValidationError("invalid-shape", "Rewrite flag requires a changed query.");
    }
    return { originalQuery, rewrittenQuery, useRewrite: true };
}

export function validateMemoryStatements(
    value: unknown,
    limits: Readonly<UtilityOutputLimits> = DEFAULT_UTILITY_OUTPUT_LIMITS,
): readonly string[] {
    if (!Array.isArray(value)) {
        throw new UtilityOutputValidationError("invalid-shape", "Memory statements must be an array.");
    }
    if (value.length > limits.memoryStatements) {
        throw new UtilityOutputValidationError("limit-exceeded", "Memory statement count exceeds the output budget.");
    }
    const seen = new Set<string>();
    return value.map((entry) => {
        const statement = requireBoundedText(entry, limits.memoryStatementCharacters, "Memory statement");
        const identity = statement.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(identity)) {
            throw new UtilityOutputValidationError("duplicate-value", "Memory statements must be unique.");
        }
        seen.add(identity);
        return statement;
    });
}

function requireExactObject(value: unknown, requiredField: string): Record<string, unknown> {
    if (!isRecord(value) || !(requiredField in value)) {
        throw new UtilityOutputValidationError("invalid-shape", `Utility output must contain ${requiredField}.`);
    }
    const fields = Object.keys(value);
    if (fields.length !== 1 || fields[0] !== requiredField) {
        throw new UtilityOutputValidationError("unexpected-field", "Utility output contains unexpected fields.");
    }
    return value;
}

function requireBoundedText(value: unknown, maximumCharacters: number, label: string): string {
    if (typeof value !== "string") {
        throw new UtilityOutputValidationError("invalid-shape", `${label} must be a string.`);
    }
    const text = value.trim();
    if (text.length === 0) {
        throw new UtilityOutputValidationError("empty-value", `${label} must not be empty.`);
    }
    if (text.length > maximumCharacters) {
        throw new UtilityOutputValidationError("limit-exceeded", `${label} exceeds the output budget.`);
    }
    return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
