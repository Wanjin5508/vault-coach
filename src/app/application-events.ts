/**
 * 应用门面向展示层发布的失效事件。
 *
 * 事件只表示相关读取模型可能已变化，不携带领域快照；监听方应按需重新读取对应 API。
 */
export type ApplicationEvent =
    | { type: "state-changed" }
    | { type: "index-state-changed" }
    | { type: "graph-state-changed" }
    | { type: "semantic-graph-state-changed" }
    | { type: "mastery-state-changed" }
    | { type: "recommendations-changed" }
    | { type: "conversation-changed" }
    | { type: "exam-history-changed" };

export type ApplicationEventListener = (event: ApplicationEvent) => void;
