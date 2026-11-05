import type { QueryRewriteResult } from "../../domain/retrieval/retrieval-types";
import type {
    MemoryExtractionPort,
    MemoryExtractionRequest,
} from "../../domain/utility/memory-extraction-port";
import type { QueryRewritePort, QueryRewriteRequest } from "../../domain/utility/query-rewrite-port";
import {
    DEFAULT_UTILITY_OUTPUT_LIMITS,
    UtilityOutputValidationError,
    type UtilityOutputLimits,
    validateMemoryStatements,
    validateQueryRewriteResult,
} from "../../domain/utility/utility-output-validation";

export type UtilityTask = "query-rewrite" | "memory-extraction";
export type UtilityFailureReason = "invalid-output" | "provider-failed";

export interface UtilityFailureEvent {
    task: UtilityTask;
    reason: UtilityFailureReason;
}

/**
 * 在 consumer 与具体 utility provider 之间冻结失败语义。
 * 非取消失败不外发正文，也不阻断回答：改写退回原问题，记忆抽取退回空候选。
 */
export class GuardedUtilityProvider implements QueryRewritePort, MemoryExtractionPort {
    constructor(
        private readonly queryRewrite: QueryRewritePort,
        private readonly memoryExtraction: MemoryExtractionPort,
        private readonly limits: Readonly<UtilityOutputLimits> = DEFAULT_UTILITY_OUTPUT_LIMITS,
        private readonly onFailure?: (event: UtilityFailureEvent) => void,
    ) {}

    async rewriteQuery(request: QueryRewriteRequest): Promise<QueryRewriteResult> {
        request.signal?.throwIfAborted();
        try {
            const result = await this.queryRewrite.rewriteQuery(request);
            request.signal?.throwIfAborted();
            return validateQueryRewriteResult(result, request.originalQuery, this.limits);
        } catch (error: unknown) {
            if (isAbortError(error)) throw error;
            this.reportFailure("query-rewrite", error);
            return {
                originalQuery: request.originalQuery,
                rewrittenQuery: request.originalQuery,
                useRewrite: false,
            };
        }
    }

    async extractMemoryStatements(request: MemoryExtractionRequest): Promise<readonly string[]> {
        request.signal?.throwIfAborted();
        try {
            const result = await this.memoryExtraction.extractMemoryStatements(request);
            request.signal?.throwIfAborted();
            return validateMemoryStatements(result, this.limits);
        } catch (error: unknown) {
            if (isAbortError(error)) throw error;
            this.reportFailure("memory-extraction", error);
            return [];
        }
    }

    private reportFailure(task: UtilityTask, error: unknown): void {
        const reason: UtilityFailureReason = error instanceof UtilityOutputValidationError
            ? "invalid-output"
            : "provider-failed";
        try {
            this.onFailure?.({ task, reason });
        } catch {
            // 诊断回调不能改变 utility 的降级语义。
        }
    }
}

function isAbortError(error: unknown): boolean {
    return typeof error === "object" && error !== null
        && "name" in error && error.name === "AbortError";
}
