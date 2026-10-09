import type { LocalChatMessage } from "./model-types";

/**
 * 生成单个 JSON 结构响应的模型能力端口。
 *
 * 领域服务依赖该窄接口，避免依赖由 Obsidian 支撑的具体模型客户端。
 */
export interface JsonGenerationGateway {
    generateJsonAnswer(messages: LocalChatMessage[], temperature: number): Promise<string>;
}
