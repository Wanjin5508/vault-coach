import { createSectionExtractionId, stableSemanticHash } from "../../domain/semantic-graph/concept-candidate-fingerprint";
import type { DocumentIndexReader } from "../../domain/documents/document-index-reader";
import type { IndexedChunk } from "../../domain/documents/document-types";
import type { GraphSnapshotV1, SectionGraphNode } from "../../domain/graph/graph-types";

export interface SectionExcerpt {
    id: string;
    chunkId: string;
    text: string;
    locator: IndexedChunk["locator"];
}

export interface SectionExtractionInput {
    id: string;
    documentId: string;
    documentPath: string;
    sectionId: string;
    headingPath: string[];
    inputHash: string;
    excerpts: SectionExcerpt[];
}

/**
 * Builds model inputs strictly from chunks directly owned by an M2 Section.
 * Child Section chunks are never copied into their parent's prompt.
 */
export function createSectionExtractionInputs(
    snapshot: GraphSnapshotV1,
    reader: DocumentIndexReader,
    maxCharactersPerWindow: number,
    documentPaths?: ReadonlySet<string>,
): SectionExtractionInput[] {
    const sections = snapshot.nodes
        .filter((node): node is SectionGraphNode => node.type === "section")
        .filter((section) => !documentPaths || documentPaths.has(section.filePath))
        .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.id.localeCompare(right.id));
    return sections.flatMap((section) => createSectionWindows(section, reader, maxCharactersPerWindow));
}

function createSectionWindows(
    section: SectionGraphNode,
    reader: DocumentIndexReader,
    maxCharactersPerWindow: number,
): SectionExtractionInput[] {
    const directChunks = section.chunkIds
        .map((chunkId) => reader.getChunkById(chunkId))
        .filter((chunk): chunk is IndexedChunk => chunk !== null)
        .filter((chunk) => chunk.filePath === section.filePath)
        .filter((chunk) => chunk.text.trim().length > 0);
    if (directChunks.length === 0) return [];
    const windowLimit = Math.max(1000, Math.floor(maxCharactersPerWindow));
    const windows: IndexedChunk[][] = [];
    let currentWindow: IndexedChunk[] = [];
    let currentLength = 0;
    for (const chunk of directChunks) {
        const length = chunk.text.length;
        if (currentWindow.length > 0 && currentLength + length > windowLimit) {
            windows.push(currentWindow);
            currentWindow = [];
            currentLength = 0;
        }
        currentWindow.push(chunk);
        currentLength += length;
    }
    if (currentWindow.length > 0) windows.push(currentWindow);
    return windows.map((window) => {
        const excerpts = window.map((chunk, index) => ({
            id: `E${index + 1}`,
            chunkId: chunk.id,
            text: chunk.text.trim(),
            locator: { ...chunk.locator },
        }));
        const inputHash = stableSemanticHash(JSON.stringify({
            sectionId: section.id,
            headingPath: section.headingPath,
            chunks: excerpts.map((excerpt) => [excerpt.chunkId, excerpt.text]),
        }));
        return {
            id: createSectionExtractionId(section.id, inputHash),
            documentId: section.documentId,
            documentPath: section.filePath,
            sectionId: section.id,
            headingPath: [...section.headingPath],
            inputHash,
            excerpts,
        };
    });
}
