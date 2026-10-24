import type { QueryRewriteResult } from "../retrieval/retrieval-types";

export interface QueryRewriteRequest {
    originalQuery: string;
    conversationContext: string;
    scopeDescription: string;
}

export interface QueryRewritePort {
    rewriteQuery(request: QueryRewriteRequest): Promise<QueryRewriteResult>;
}
