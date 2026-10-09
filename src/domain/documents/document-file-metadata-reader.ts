/**
 * 读取未包含在持久化索引中的文件元数据。
 *
 * 考试范围通过该窄端口读取笔记的实时 frontmatter，避免依赖 Obsidian 的 `App`、
 * `TFile` 或元数据缓存 API。
 */
export interface DocumentFileMetadata {
    frontmatter: Readonly<Record<string, unknown>> | null;
}

/** 实时文件元数据读取端口；找不到文件或元数据不可用时返回空值。 */
export interface DocumentFileMetadataReader {
    getFileMetadata(filePath: string): DocumentFileMetadata | null;
}
