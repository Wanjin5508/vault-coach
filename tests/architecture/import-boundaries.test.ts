import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

function getTypeScriptFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        return statSync(path).isDirectory()
            ? getTypeScriptFiles(path)
            : path.endsWith(".ts") ? [path] : [];
    });
}

function sourceOf(path: string): string {
    return readFileSync(path, "utf8");
}

describe("architecture import boundaries", () => {
    it("keeps domain modules independent from Obsidian", () => {
        const domainFiles = getTypeScriptFiles(join(sourceRoot, "domain"));
        const violations = domainFiles.filter((path) => /from\s+["']obsidian["']/.test(sourceOf(path)));

        expect(violations.map((path) => relative(sourceRoot, path))).toEqual([]);
    });

    it("keeps presentation independent from concrete business services", () => {
        const presentationFiles = getTypeScriptFiles(join(sourceRoot, "presentation"));
        const forbiddenServices = /from\s+["'][^"']*(?:rag-engine|knowledge-base|vector-store|exam-engine|exam-session-store|memory-service|model-client)[^"']*["']/;
        const violations = presentationFiles.filter((path) => forbiddenServices.test(sourceOf(path)));

        expect(violations.map((path) => relative(sourceRoot, path))).toEqual([]);
    });

    it("keeps exam behavior out of RAG and knowledge-base APIs", () => {
        const ragEngineSource = sourceOf(join(sourceRoot, "rag-engine.ts"));
        const knowledgeBaseSource = sourceOf(join(sourceRoot, "knowledge-base.ts"));

        expect(ragEngineSource).not.toMatch(/from\s+["'][^"']*exam[^"']*["']/i);
        expect(ragEngineSource).not.toMatch(/\b(?:ExamEngine|ExamSession|ExamQuestion|ExamScope)\b/);
        expect(knowledgeBaseSource).not.toMatch(/\b(?:getExam|readExam|createExam|analyzeExam)\w*/);
    });

    it("uses the compatibility types barrel only as a barrel", () => {
        const productionFiles = getTypeScriptFiles(sourceRoot)
            .filter((path) => relative(sourceRoot, path) !== "types.ts");
        const legacyTypeImports = productionFiles.filter((path) => {
            return /from\s+["'][^"']*(?:\/|\.)types["']/.test(sourceOf(path));
        });

        expect(legacyTypeImports.map((path) => relative(sourceRoot, path))).toEqual([]);
    });

    it("keeps the plugin entry as a composition root and main as a default export", () => {
        const pluginSource = sourceOf(join(sourceRoot, "vault-coach-plugin.ts"));
        const mainSource = sourceOf(join(sourceRoot, "main.ts")).trim();
        const concreteServiceImports = /from\s+["'][^"']*(?:rag-engine|knowledge-base|vector-store|exam-engine|exam-session-store|memory-service|model-client)[^"']*["']/;

        expect(pluginSource).not.toMatch(concreteServiceImports);
        expect(mainSource).toBe('import VaultCoach from "./vault-coach-plugin";\n\nexport default VaultCoach;');
    });

    it("keeps the ItemView shell small and reserves a non-navigable Progress boundary", () => {
        const legacyViewSource = sourceOf(join(sourceRoot, "view.ts")).trim();
        const shellSource = sourceOf(join(sourceRoot, "presentation", "vault-coach-view.ts"));
        const progressControllerSource = sourceOf(join(sourceRoot, "presentation", "controllers", "progress-controller.ts"));
        const progressViewSource = sourceOf(join(sourceRoot, "presentation", "views", "progress-view.ts"));

        expect(legacyViewSource).toContain('export { VaultCoachView } from "./presentation/vault-coach-view";');
        expect(shellSource.split("\n").length).toBeLessThanOrEqual(350);
        expect(shellSource).not.toMatch(/domain\/exam|ExamGenerationProgress|ExamSession/);
        expect(progressControllerSource).toContain("isAvailable(): false");
        expect(progressViewSource).toContain("render(_rootEl");
    });
});
