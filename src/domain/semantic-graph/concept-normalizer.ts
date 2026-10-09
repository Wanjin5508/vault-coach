/**
 * 保守归一化定义展示层来源聚合所需的术语精确相等规则。
 *
 * 相似度或仅相关的别名不能推导合并；合并必须来自用户明确决策。
 */
export function normalizeConceptName(value: string): string {
    return value
        .normalize("NFC")
        .trim()
        .toLocaleLowerCase()
        .replace(/[\u2010-\u2015_./·]+/g, " ")
        .replace(/\[|\]/g, " ")
        .replace(/[(){}'"“”‘’`]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function normalizeConceptAlias(value: string): string {
    return normalizeConceptName(value);
}

export function normalizeConceptAliases(values: readonly string[], canonicalName: string): string[] {
    const canonical = normalizeConceptName(canonicalName);
    return Array.from(new Set(values
        .map((value) => value.normalize("NFC").trim())
        .filter((value) => value.length > 0)
        .filter((value) => normalizeConceptAlias(value) !== canonical)))
        .sort((left, right) => left.localeCompare(right));
}
