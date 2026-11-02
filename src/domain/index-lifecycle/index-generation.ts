import type { SourceInventoryV1 } from "./source-inventory";

/** Core generation 只冻结文本来源与解析设置；embedding 配置不会使 keyword generation 失效。 */
export function createCoreGenerationId(settingsSignature: string, inventory: SourceInventoryV1): string {
    return `core-v1:${stableHash(`${settingsSignature}\u0000${inventory.fingerprint}`)}`;
}

function stableHash(source: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
