import type { LocalChatMessage } from "./model-types";

/**
 * Port for a model capability that produces one JSON-shaped response.
 *
 * Domain services use this narrow interface instead of depending on the
 * concrete Obsidian-backed model client.
 */
export interface JsonGenerationGateway {
    generateJsonAnswer(messages: LocalChatMessage[], temperature: number): Promise<string>;
}
