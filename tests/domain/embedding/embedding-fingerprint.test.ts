import { describe, expect, it } from "vitest";
import {
    areEmbeddingFingerprintsEqual,
    canonicalizeEmbeddingFingerprint,
    createEmbeddingFingerprint,
    getEmbeddingFingerprintDisplayId,
    isFingerprintCompatibleWithDescriptor,
} from "../../../src/domain/embedding/embedding-fingerprint";

const descriptor = {
    providerId: "ollama" as const,
    endpointIdentity: "http://localhost:11434",
    model: "embeddinggemma",
    revision: "unreported",
    modelDtype: "provider-defined",
    outputDtype: "float32" as const,
    pooling: "provider-defined",
    normalization: "consumer-l2-v1",
    preprocessing: { document: "identity-v1", query: "identity-v1", graph: "identity-v1" },
    implementationVersion: 1,
};

describe("embedding fingerprint", () => {
    it("uses complete semantic fields for compatibility and stable display IDs", () => {
        const first = createEmbeddingFingerprint(descriptor, 3);
        const same = createEmbeddingFingerprint({ ...descriptor, preprocessing: { ...descriptor.preprocessing } }, 3);
        expect(areEmbeddingFingerprintsEqual(first, same)).toBe(true);
        expect(getEmbeddingFingerprintDisplayId(first)).toBe(getEmbeddingFingerprintDisplayId(same));
        expect(canonicalizeEmbeddingFingerprint(first)).not.toContain("apiKey");
        expect(isFingerprintCompatibleWithDescriptor(first, descriptor)).toBe(true);
    });

    it("rejects changes to dtype, preprocessing, implementation, and dimension", () => {
        const base = createEmbeddingFingerprint(descriptor, 3);
        expect(areEmbeddingFingerprintsEqual(base, createEmbeddingFingerprint({ ...descriptor, modelDtype: "q4" }, 3))).toBe(false);
        expect(areEmbeddingFingerprintsEqual(base, createEmbeddingFingerprint({ ...descriptor,
            preprocessing: { ...descriptor.preprocessing, query: "query-prefix-v2" } }, 3))).toBe(false);
        expect(areEmbeddingFingerprintsEqual(base, createEmbeddingFingerprint({ ...descriptor, implementationVersion: 2 }, 3))).toBe(false);
        expect(areEmbeddingFingerprintsEqual(base, createEmbeddingFingerprint(descriptor, 4))).toBe(false);
    });

    it("rejects invalid dimensions and incomplete descriptors", () => {
        expect(() => createEmbeddingFingerprint(descriptor, 0)).toThrow();
        expect(() => createEmbeddingFingerprint({ ...descriptor, model: "" }, 3)).toThrow();
        expect(isFingerprintCompatibleWithDescriptor(createEmbeddingFingerprint(descriptor, 3), { ...descriptor, model: "" })).toBe(false);
    });
});
