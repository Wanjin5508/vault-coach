import type { SemanticRelationType } from "./semantic-graph-types";

export function stableSemanticHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createSectionExtractionId(sectionId: string, inputHash: string): string {
    return `section:${sectionId}:${inputHash}`;
}

export function createSectionConceptCandidateId(sectionId: string, normalizedName: string): string {
    return `candidate:concept:${stableSemanticHash(`${sectionId}\u0000${normalizedName}`)}`;
}

export function createSemanticConceptId(sectionId: string, normalizedName: string): string {
    return `concept:${stableSemanticHash(`${sectionId}\u0000${normalizedName}`)}`;
}

export function createRelationCandidateFingerprint(
    type: SemanticRelationType,
    sourceConceptId: string,
    targetConceptId: string,
    algorithmSignature: string,
): string {
    const [source, target] = isUndirectedRelation(type)
        ? [sourceConceptId, targetConceptId].sort((left, right) => left.localeCompare(right))
        : [sourceConceptId, targetConceptId];
    return `candidate:relation:${type}:${stableSemanticHash(`${source}\u0000${target}\u0000${algorithmSignature}`)}`;
}

export function createManualRelationId(type: SemanticRelationType, sourceConceptId: string, targetConceptId: string, nonce: string): string {
    return `relation:user:${stableSemanticHash(`${type}\u0000${sourceConceptId}\u0000${targetConceptId}\u0000${nonce}`)}`;
}

export function isUndirectedRelation(type: SemanticRelationType): boolean {
    return type === "same_as" || type === "contrasts_with" || type === "related_to";
}
