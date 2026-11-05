import { build } from "esbuild";
import path from "node:path";
import { REPOSITORY_ROOT } from "./config.mjs";

/**
 * Node smoke 直接复用生产 TypeScript 校验器，避免实验脚本复制一套更宽松的 JSON 规则。
 * 仅在内存中构建并通过 data URL 加载，不产生或提交构建产物。
 */
export async function loadUtilityOutputValidation() {
    const validatorPath = path.join(REPOSITORY_ROOT, "src/domain/utility/utility-output-validation.ts");
    const result = await build({
        stdin: {
            contents: `export * from ${JSON.stringify(validatorPath)};`,
            resolveDir: REPOSITORY_ROOT,
            sourcefile: "utility-validation-entry.mjs",
            loader: "js",
        },
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        write: false,
        logLevel: "silent",
    });
    const source = result.outputFiles[0]?.text;
    if (!source) throw new Error("无法构建 Utility 输出校验器。");
    return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
