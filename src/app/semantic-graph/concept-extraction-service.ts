import { createSectionConceptCandidateId } from "../../domain/semantic-graph/concept-candidate-fingerprint";
import { normalizeConceptAliases, normalizeConceptName } from "../../domain/semantic-graph/concept-normalizer";
import type { JsonGenerationGateway } from "../../domain/model/json-generation-gateway";
import { generateParsedJsonAnswer } from "../../domain/model/structured-output-service";
import type {
    ConceptEvidenceRef,
    SectionConceptCandidate,
    SectionExtractionRecord,
    SectionRelationProposal,
    SemanticModelMetadata,
    SemanticRelationType,
} from "../../domain/semantic-graph/semantic-graph-types";
import type { SectionExtractionInput, SectionExcerpt } from "./section-extraction-input";

export const CONCEPT_EXTRACTION_PROMPT_VERSION = "semantic-concept-extraction/v1";
export const CONCEPT_RELATION_PROMPT_VERSION = "semantic-relation-extraction/v1";

/** Validates strictly structured model output before it can enter persistence. */
export class ConceptExtractionService {
    constructor(private readonly gateway: JsonGenerationGateway) {}

    async extract(
        input: SectionExtractionInput,
        model: SemanticModelMetadata,
        signal?: AbortSignal,
    ): Promise<SectionExtractionRecord> {
        signal?.throwIfAborted();
        const conceptPayload = await generateParsedJsonAnswer<unknown>(
            this.gateway,
            this.buildConceptMessages(input),
            0,
            CONCEPT_SCHEMA_DESCRIPTION,
            "概念抽取",
            signal,
        );
        const candidates = this.validateConceptPayload(conceptPayload, input);
        signal?.throwIfAborted();
        const relations = candidates.length < 2
            ? []
            : await this.extractRelations(input, candidates, signal);
        return {
            id: input.id,
            documentId: input.documentId,
            documentPath: input.documentPath,
            sectionId: input.sectionId,
            headingPath: [...input.headingPath],
            inputHash: input.inputHash,
            extractorSignature: `${model.provider}:${model.modelName}:${model.promptVersion}:${model.schemaVersion}`,
            candidates,
            relations,
            updatedAt: model.generatedAt,
            lastError: null,
            model: { ...model },
        };
    }

    private async extractRelations(
        input: SectionExtractionInput,
        candidates: readonly SectionConceptCandidate[],
        signal?: AbortSignal,
    ): Promise<SectionRelationProposal[]> {
        const payload = await generateParsedJsonAnswer<unknown>(
            this.gateway,
            this.buildRelationMessages(input, candidates),
            0,
            RELATION_SCHEMA_DESCRIPTION,
            "概念关系抽取",
            signal,
        );
        return this.validateRelationPayload(payload, input, candidates);
    }

    private validateConceptPayload(value: unknown, input: SectionExtractionInput): SectionConceptCandidate[] {
        if (!isRecord(value) || !hasOnlyKeys(value, ["concepts"]) || !Array.isArray(value.concepts)) {
            throw new Error("概念抽取返回值不符合 JSON schema。");
        }
        const excerpts = this.createEvidenceMap(input);
        const candidates = value.concepts.slice(0, 24).map((item, index) => {
            if (!isRecord(item)
                || !hasOnlyKeys(item, ["name", "aliases", "description", "source_excerpt_ids"])
                || typeof item.name !== "string"
                || !Array.isArray(item.aliases)
                || !item.aliases.every((alias) => typeof alias === "string")
                || typeof item.description !== "string"
                || !Array.isArray(item.source_excerpt_ids)
                || !item.source_excerpt_ids.every((excerptId) => typeof excerptId === "string")) {
                throw new Error(`概念抽取第 ${index + 1} 项不符合 JSON schema。`);
            }
            const name = item.name.normalize("NFC").trim();
            const normalizedName = normalizeConceptName(name);
            if (!name || !normalizedName || name.length > 160 || item.description.length > 800) {
                throw new Error(`概念抽取第 ${index + 1} 项包含无效名称或描述。`);
            }
            const evidence = this.resolveEvidence(item.source_excerpt_ids, excerpts, `概念 ${name}`);
            return {
                id: createSectionConceptCandidateId(input.sectionId, normalizedName),
                name,
                normalizedName,
                aliases: normalizeConceptAliases(item.aliases.slice(0, 12), name),
                description: item.description.trim(),
                evidence,
            };
        });
        return mergeCandidates(candidates);
    }

    private validateRelationPayload(
        value: unknown,
        input: SectionExtractionInput,
        candidates: readonly SectionConceptCandidate[],
    ): SectionRelationProposal[] {
        if (!isRecord(value) || !hasOnlyKeys(value, ["relations"]) || !Array.isArray(value.relations)) {
            throw new Error("概念关系抽取返回值不符合 JSON schema。");
        }
        const allowedTypes = new Set<SemanticRelationType>([
            "part_of", "prerequisite_of", "used_for", "contrasts_with", "related_to",
        ]);
        const candidateIds = new Set(candidates.map((candidate) => candidate.id));
        const excerpts = this.createEvidenceMap(input);
        const relations: SectionRelationProposal[] = [];
        for (const item of value.relations.slice(0, 30)) {
            if (!isRecord(item)
                || !hasOnlyKeys(item, ["type", "source_candidate_id", "target_candidate_id", "confidence", "source_excerpt_ids"])
                || typeof item.type !== "string"
                || typeof item.source_candidate_id !== "string"
                || typeof item.target_candidate_id !== "string"
                || typeof item.confidence !== "number"
                || !Array.isArray(item.source_excerpt_ids)
                || !item.source_excerpt_ids.every((excerptId) => typeof excerptId === "string")) {
                throw new Error("概念关系抽取包含不符合 schema 的项目。");
            }
            if (!allowedTypes.has(item.type as SemanticRelationType)
                || item.source_candidate_id === item.target_candidate_id
                || !candidateIds.has(item.source_candidate_id)
                || !candidateIds.has(item.target_candidate_id)
                || !Number.isFinite(item.confidence)
                || item.confidence < 0
                || item.confidence > 1) {
                throw new Error("概念关系抽取包含未知端点、关系类型或置信度。");
            }
            relations.push({
                type: item.type as Exclude<SemanticRelationType, "same_as">,
                sourceCandidateId: item.source_candidate_id,
                targetCandidateId: item.target_candidate_id,
                confidence: item.confidence,
                evidence: this.resolveEvidence(item.source_excerpt_ids, excerpts, "概念关系"),
            });
        }
        return dedupeRelations(relations);
    }

    private createEvidenceMap(input: SectionExtractionInput): Map<string, ConceptEvidenceRef> {
        return new Map(input.excerpts.map((excerpt) => [excerpt.id, toEvidence(input, excerpt)]));
    }

    private resolveEvidence(
        excerptIds: readonly string[],
        evidenceByExcerptId: ReadonlyMap<string, ConceptEvidenceRef>,
        owner: string,
    ): ConceptEvidenceRef[] {
        const evidence = Array.from(new Set(excerptIds)).map((excerptId) => evidenceByExcerptId.get(excerptId));
        if (evidence.length === 0 || evidence.some((item) => !item)) {
            throw new Error(`${owner} 未引用当前 Section 的有效 excerpt 证据。`);
        }
        return evidence.filter((item): item is ConceptEvidenceRef => item !== undefined)
            .map((item) => ({ ...item, locator: { ...item.locator } }));
    }

    private buildConceptMessages(input: SectionExtractionInput) {
        return [{
            role: "system" as const,
            content: [
                "你是知识库概念抽取器。只从给出的 Section excerpt 中抽取明确出现或被直接定义的概念。",
                "不得创建没有 evidence 的概念，不得把标签、文件名或猜测自动当作概念。",
                "只输出严格 JSON，不要 Markdown。",
                CONCEPT_SCHEMA_DESCRIPTION,
            ].join("\n"),
        }, {
            role: "user" as const,
            content: formatSectionInput(input),
        }];
    }

    private buildRelationMessages(input: SectionExtractionInput, candidates: readonly SectionConceptCandidate[]) {
        return [{
            role: "system" as const,
            content: [
                "你是知识库概念关系抽取器。只能使用给定候选概念和 Section excerpt。",
                "允许的 type 仅为 part_of、prerequisite_of、used_for、contrasts_with、related_to。",
                "每条关系必须引用至少一个 excerpt；没有明确证据时返回空数组。",
                "只输出严格 JSON，不要 Markdown。",
                RELATION_SCHEMA_DESCRIPTION,
            ].join("\n"),
        }, {
            role: "user" as const,
            content: [
                formatSectionInput(input),
                "",
                "已验证候选概念：",
                ...candidates.map((candidate) => `${candidate.id}: ${candidate.name} — ${candidate.description}`),
            ].join("\n"),
        }];
    }
}

function toEvidence(input: SectionExtractionInput, excerpt: SectionExcerpt): ConceptEvidenceRef {
    return {
        sectionId: input.sectionId,
        chunkId: excerpt.chunkId,
        locator: { ...excerpt.locator },
        excerptId: excerpt.id,
        inputHash: input.inputHash,
        textPreview: excerpt.text.slice(0, 360),
    };
}

function formatSectionInput(input: SectionExtractionInput): string {
    return [
        `Document: ${input.documentPath}`,
        `Section: ${input.headingPath.join(" > ") || "(root)"}`,
        "",
        ...input.excerpts.map((excerpt) => `${excerpt.id} [${excerpt.chunkId}]：${excerpt.text}`),
    ].join("\n");
}

function mergeCandidates(candidates: readonly SectionConceptCandidate[]): SectionConceptCandidate[] {
    const byId = new Map<string, SectionConceptCandidate>();
    for (const candidate of candidates) {
        const existing = byId.get(candidate.id);
        if (!existing) {
            byId.set(candidate.id, candidate);
            continue;
        }
        existing.aliases = normalizeConceptAliases([...existing.aliases, ...candidate.aliases], existing.name);
        existing.evidence = dedupeEvidence([...existing.evidence, ...candidate.evidence]);
        if (candidate.description.length > existing.description.length) existing.description = candidate.description;
    }
    return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function dedupeRelations(relations: readonly SectionRelationProposal[]): SectionRelationProposal[] {
    const byKey = new Map<string, SectionRelationProposal>();
    for (const relation of relations) {
        const key = `${relation.type}\u0000${relation.sourceCandidateId}\u0000${relation.targetCandidateId}`;
        const existing = byKey.get(key);
        if (!existing || relation.confidence > existing.confidence) byKey.set(key, relation);
    }
    return Array.from(byKey.values()).sort((left, right) => {
        const leftKey = `${left.type}:${left.sourceCandidateId}:${left.targetCandidateId}`;
        const rightKey = `${right.type}:${right.sourceCandidateId}:${right.targetCandidateId}`;
        return leftKey.localeCompare(rightKey);
    });
}

function dedupeEvidence(evidence: readonly ConceptEvidenceRef[]): ConceptEvidenceRef[] {
    const deduped = new Map(evidence.map((item) => [`${item.sectionId}:${item.chunkId}:${item.excerptId}`, item]));
    return Array.from(deduped.values()).sort((left, right) => left.chunkId.localeCompare(right.chunkId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

const CONCEPT_SCHEMA_DESCRIPTION = '{"concepts":[{"name":"string","aliases":["string"],"description":"string","source_excerpt_ids":["E1"]}]}';
const RELATION_SCHEMA_DESCRIPTION = '{"relations":[{"type":"part_of|prerequisite_of|used_for|contrasts_with|related_to","source_candidate_id":"candidate:concept:...","target_candidate_id":"candidate:concept:...","confidence":0.0,"source_excerpt_ids":["E1"]}]}';
