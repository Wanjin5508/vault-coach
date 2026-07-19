/**
 * Read-only access to file metadata that is not part of the persisted index.
 *
 * The exam scope needs this small port to respect a note's live frontmatter
 * without depending on Obsidian's App, TFile, or metadata cache APIs.
 */
export interface DocumentFileMetadata {
    frontmatter: Readonly<Record<string, unknown>> | null;
}

export interface DocumentFileMetadataReader {
    getFileMetadata(filePath: string): DocumentFileMetadata | null;
}
