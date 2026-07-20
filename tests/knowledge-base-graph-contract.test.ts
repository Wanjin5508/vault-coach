import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { VaultCoachSettings } from "../src/app/config/settings-types";
import { VaultKnowledgeBase } from "../src/knowledge-base";

interface VaultFixtureEntry {
    content: string;
    modifiedAt: number;
}

interface RuntimeFixtureFile {
    path: string;
    extension: string;
    basename: string;
    stat: {
        size: number;
        mtime: number;
    };
}

const fixtureRoot: string = fileURLToPath(new URL("./fixtures/vault-graph/basic/", import.meta.url));
const INDEX_SETTINGS: VaultCoachSettings = {
    enableMarkdownIndexing: true,
    enablePdfIndexing: false,
    knowledgeScopeMode: "wholeVault",
    knowledgeFolder: "",
    chunkSize: 300,
    chunkOverlap: 0,
} as VaultCoachSettings;

describe("VaultKnowledgeBase graph integration contract", () => {
    it("indexes graph fixture files deterministically and excludes the VaultCoach hidden directory", async () => {
        const vault: MutableFixtureVault = createBasicGraphFixtureVault();
        const knowledgeBase = new VaultKnowledgeBase(vault.app, () => INDEX_SETTINGS);

        const result = await knowledgeBase.rebuildIndexDetailed();

        expect(result.affectedFiles).toEqual(["details.md", "overview.md"]);
        expect(result.stats).toMatchObject({
            fileCount: 2,
            scopeDescription: "整个 Vault",
        });
        expect(knowledgeBase.getFileRecords().map((record) => record.filePath)).toEqual(["details.md", "overview.md"]);
        expect(knowledgeBase.getFileRecord(".vault-coach/ignored.md")).toBeNull();
        expect(knowledgeBase.getChunksByFilePath(".vault-coach/ignored.md")).toEqual([]);

        const overviewChunks = knowledgeBase.getChunksByFilePath("overview.md");
        expect(overviewChunks.map((chunk) => chunk.headingPath)).toEqual(expect.arrayContaining([
            [],
            ["Retrieval"],
            ["Retrieval", "Fusion"],
            ["Retrieval", "Repeated heading"],
        ]));
        expect(result.changedChunks.map((chunk) => chunk.filePath)).toEqual([
            ...Array.from({ length: knowledgeBase.getChunksByFilePath("details.md").length }, () => "details.md"),
            ...Array.from({ length: overviewChunks.length }, () => "overview.md"),
        ]);
    });

    it("reports changed and removed chunks for a file rename without rebuilding unaffected records", async () => {
        const vault: MutableFixtureVault = createBasicGraphFixtureVault();
        const knowledgeBase = new VaultKnowledgeBase(vault.app, () => INDEX_SETTINGS);
        await knowledgeBase.rebuildIndexDetailed();

        const previousDetailChunkIds = knowledgeBase.getChunksByFilePath("details.md").map((chunk) => chunk.id);
        vault.rename("details.md", "renamed-details.md");
        vault.write("overview.md", `${vault.read("overview.md")}\n\nA changed paragraph for incremental synchronization.`);

        const result = await knowledgeBase.syncChangedFiles([
            "details.md",
            "renamed-details.md",
            "overview.md",
        ]);

        expect(result.affectedFiles).toEqual(["details.md", "renamed-details.md", "overview.md"]);
        expect(result.removedChunkIds).toEqual(expect.arrayContaining(previousDetailChunkIds));
        expect(result.changedChunks.map((chunk) => chunk.filePath)).toEqual(expect.arrayContaining([
            "renamed-details.md",
            "overview.md",
        ]));
        expect(knowledgeBase.getFileRecord("details.md")).toBeNull();
        expect(knowledgeBase.getFileRecord("renamed-details.md")).toMatchObject({
            filePath: "renamed-details.md",
            documentId: "markdown:renamed-details.md",
        });
        expect(knowledgeBase.getChunksByFilePath("overview.md").map((chunk) => chunk.text).join("\n"))
            .toContain("A changed paragraph for incremental synchronization.");
        expect(knowledgeBase.getChunksByFilePath(".vault-coach/ignored.md")).toEqual([]);
    });
});

class MutableFixtureVault {
    readonly app: App;
    private readonly entries = new Map<string, VaultFixtureEntry>();

    constructor(initialEntries: Readonly<Record<string, string>>) {
        let modifiedAt = 1704164645000;
        for (const [path, content] of Object.entries(initialEntries)) {
            this.entries.set(path, { content, modifiedAt });
            modifiedAt += 1000;
        }

        this.app = {
            vault: {
                getFiles: (): RuntimeFixtureFile[] => Array.from(this.entries.keys())
                    .sort((left, right) => left.localeCompare(right))
                    .map((path) => this.toRuntimeFile(path)),
                cachedRead: async (file: RuntimeFixtureFile): Promise<string> => this.read(file.path),
            },
        } as unknown as App;
    }

    read(path: string): string {
        const entry = this.entries.get(path);
        if (!entry) throw new Error(`Fixture file does not exist: ${path}`);
        return entry.content;
    }

    rename(oldPath: string, newPath: string): void {
        const entry = this.entries.get(oldPath);
        if (!entry) throw new Error(`Fixture file does not exist: ${oldPath}`);
        this.entries.delete(oldPath);
        this.entries.set(newPath, { ...entry, modifiedAt: entry.modifiedAt + 1000 });
    }

    write(path: string, content: string): void {
        const previous = this.entries.get(path);
        this.entries.set(path, {
            content,
            modifiedAt: (previous?.modifiedAt ?? 1704164645000) + 1000,
        });
    }

    private toRuntimeFile(path: string): RuntimeFixtureFile {
        const entry = this.entries.get(path);
        if (!entry) throw new Error(`Fixture file does not exist: ${path}`);
        const fileName: string = path.split("/").pop() ?? path;
        const extension: string = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
        const basename: string = extension.length > 0 ? fileName.slice(0, -(extension.length + 1)) : fileName;

        return {
            path,
            extension,
            basename,
            stat: {
                size: Buffer.byteLength(entry.content, "utf8"),
                mtime: entry.modifiedAt,
            },
        };
    }
}

function createBasicGraphFixtureVault(): MutableFixtureVault {
    return new MutableFixtureVault({
        "overview.md": readFixture("overview.md"),
        "details.md": readFixture("details.md"),
        ".vault-coach/ignored.md": readFixture(".vault-coach/ignored.md"),
    });
}

function readFixture(relativePath: string): string {
    return readFileSync(`${fixtureRoot}${relativePath}`, "utf8");
}
