/** 解析 M4 脚本的小型参数集合；未知参数直接失败，避免拼写错误产生错误实验。 */
export function parseArguments(argv, specification) {
    const result = Object.fromEntries(Object.entries(specification).map(([key, value]) => [key, value.defaultValue]));
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token?.startsWith("--")) throw new Error(`无法识别的参数：${token ?? ""}`);
        const separator = token.indexOf("=");
        const rawName = separator >= 0 ? token.slice(2, separator) : token.slice(2);
        const rule = specification[rawName];
        if (!rule) throw new Error(`未知参数：--${rawName}`);
        if (rule.type === "boolean") {
            result[rawName] = separator >= 0 ? parseBoolean(token.slice(separator + 1), rawName) : true;
            continue;
        }
        const rawValue = separator >= 0 ? token.slice(separator + 1) : argv[++index];
        if (rawValue === undefined || rawValue.startsWith("--")) throw new Error(`--${rawName} 缺少值。`);
        result[rawName] = rule.type === "number" ? parseNumber(rawValue, rawName) : rawValue;
    }
    return result;
}

function parseBoolean(value, name) {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`--${name} 只接受 true 或 false。`);
}

function parseNumber(value, name) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} 必须是有限数值。`);
    return parsed;
}
