export type ApplicationEvent =
    | { type: "state-changed" }
    | { type: "index-state-changed" }
    | { type: "graph-state-changed" }
    | { type: "semantic-graph-state-changed" }
    | { type: "mastery-state-changed" }
    | { type: "conversation-changed" }
    | { type: "exam-history-changed" };

export type ApplicationEventListener = (event: ApplicationEvent) => void;
