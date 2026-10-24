import type { ChatProvider } from "../../domain/model/chat-provider";
import type { MemoryExtractionPort, MemoryExtractionRequest } from "../../domain/utility/memory-extraction-port";
import type { QueryRewritePort, QueryRewriteRequest } from "../../domain/utility/query-rewrite-port";

/** M3 兼容桥；M6.2 会把两个任务路由到独立 Utility SLM。 */
export class LegacyChatUtilityAdapter implements QueryRewritePort, MemoryExtractionPort {
    constructor(private readonly chatProvider: ChatProvider) {}

    rewriteQuery(request: QueryRewriteRequest) {
        return this.chatProvider.rewriteQuery(request.originalQuery, request.conversationContext, request.scopeDescription);
    }

    extractMemoryStatements(request: MemoryExtractionRequest) {
        return this.chatProvider.extractMemoryStatements(
            request.conversationContext,
            request.latestUserText,
            request.latestAssistantText,
        );
    }
}
