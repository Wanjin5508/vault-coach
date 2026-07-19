import { App, normalizePath, TFile } from "obsidian";
import type {
    DocumentFileMetadata,
    DocumentFileMetadataReader,
} from "../../domain/documents/document-file-metadata-reader";

/**
 * Obsidian-backed implementation of the live document metadata port.
 */
export class ObsidianDocumentFileMetadataReader implements DocumentFileMetadataReader {
    private readonly app: App;

    constructor(app: App) {
        this.app = app;
    }

    getFileMetadata(filePath: string): DocumentFileMetadata | null {
        const abstractFile = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
        if (!(abstractFile instanceof TFile)) {
            return null;
        }

        const frontmatter = this.app.metadataCache.getFileCache(abstractFile)?.frontmatter;
        return {
            frontmatter: frontmatter ? { ...frontmatter } : null,
        };
    }
}
