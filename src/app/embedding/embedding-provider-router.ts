import type { VaultCoachSettings } from "../config/settings-types";
import { EmbeddingError } from "../../domain/embedding/embedding-error";
import type {
    EmbeddingBatch,
    EmbeddingProvider,
    EmbeddingProviderDescriptor,
    EmbeddingProviderId,
    EmbeddingRequest,
} from "../../domain/embedding/embedding-provider";

/**
 * 将持久化设置解析为 provider。所有 consumer 共用本实例，避免各自实现选择规则。
 */
export class EmbeddingProviderRouter implements EmbeddingProvider {
    private readonly providers: ReadonlyMap<EmbeddingProviderId, EmbeddingProvider>;

    constructor(
        private readonly getSettings: () => VaultCoachSettings,
        providers: readonly EmbeddingProvider[],
    ) {
        this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    }

    get id(): EmbeddingProviderId {
        return this.getActiveProvider().id;
    }

    describe(): EmbeddingProviderDescriptor {
        return this.getActiveProvider().describe();
    }

    embed(request: EmbeddingRequest): Promise<EmbeddingBatch> {
        return this.getActiveProvider().embed(request);
    }

    private getActiveProvider(): EmbeddingProvider {
        const providerId = this.getSettings().embeddingProvider;
        const provider = this.providers.get(providerId);
        if (!provider) throw new EmbeddingError("invalid-request", providerId, `Unsupported embedding provider: ${providerId}`);
        return provider;
    }
}
