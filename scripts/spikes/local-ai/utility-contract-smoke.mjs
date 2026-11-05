import { loadUtilityOutputValidation } from "./lib/utility-validation-runtime.mjs";

const validation = await loadUtilityOutputValidation();
const checks = [
    () => validation.parseQueryRewriteOutput('{"rewritten_query":"offline index rebuild"}', "rebuild it"),
    () => validation.parseMemoryExtractionOutput('{"memories":["The user prefers local inference."]}'),
    () => expectCode(validation, "invalid-json", () => validation.parseQueryRewriteOutput("```json\n{}\n```", "query")),
    () => expectCode(validation, "unexpected-field", () => validation.parseQueryRewriteOutput('{"rewritten_query":"x","note":"y"}', "query")),
    () => expectCode(validation, "duplicate-value", () => validation.parseMemoryExtractionOutput('{"memories":["Local only"," local  only "]}')),
];

for (const check of checks) check();
console.log(`[M6.2] Utility 严格输出契约 smoke 通过：${checks.length} checks。`);

function expectCode(runtime, expectedCode, operation) {
    try {
        operation();
    } catch (error) {
        if (error instanceof runtime.UtilityOutputValidationError && error.code === expectedCode) return;
        throw error;
    }
    throw new Error(`预期 UtilityOutputValidationError(${expectedCode})，但操作成功。`);
}
