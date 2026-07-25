import { REVIEW_ACTIONS_PATH, RECOMMENDATIONS_DIR_PATH, VAULT_COACH_HIDDEN_DIR_PATH } from "../../constants";
import { REVIEW_ACTIONS_SCHEMA_VERSION, type ReviewActionEvent, type ReviewActionStore, type ReviewActionsDocumentV1 } from "../../domain/recommendation/recommendation-types";

export interface ReviewActionStorageAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
}

/** Small append-only local fact store. Recommendation snapshots are never stored here. */
export class JsonReviewActionStore implements ReviewActionStore {
    constructor(private readonly adapter: ReviewActionStorageAdapter) {}

    async list(): Promise<ReviewActionEvent[]> {
        const document = await this.readDocument();
        return document.events.map((event) => ({ ...event }));
    }

    async append(event: ReviewActionEvent): Promise<void> {
        const document = await this.readDocument();
        if (document.events.some((item) => item.id === event.id)) return;
        const normalized = validateEvent(event);
        await this.ensureDirectory();
        await this.adapter.write(REVIEW_ACTIONS_PATH, JSON.stringify({
            schemaVersion: REVIEW_ACTIONS_SCHEMA_VERSION,
            events: [...document.events, normalized].sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id)),
        }, null, 2));
    }

    private async readDocument(): Promise<ReviewActionsDocumentV1> {
        if (!(await this.adapter.exists(REVIEW_ACTIONS_PATH))) return { schemaVersion: REVIEW_ACTIONS_SCHEMA_VERSION, events: [] };
        let value: unknown;
        try {
            value = JSON.parse(await this.adapter.read(REVIEW_ACTIONS_PATH));
        } catch {
            throw new Error("无法解析 Review action JSON。请先备份该文件后再修复。");
        }
        if (!isRecord(value) || value.schemaVersion !== REVIEW_ACTIONS_SCHEMA_VERSION || !Array.isArray(value.events)) {
            throw new Error("Review action JSON 格式无效。");
        }
        return { schemaVersion: REVIEW_ACTIONS_SCHEMA_VERSION, events: value.events.map(validateEvent) };
    }

    private async ensureDirectory(): Promise<void> {
        if (!(await this.adapter.exists(VAULT_COACH_HIDDEN_DIR_PATH))) await this.adapter.mkdir(VAULT_COACH_HIDDEN_DIR_PATH);
        if (!(await this.adapter.exists(RECOMMENDATIONS_DIR_PATH))) await this.adapter.mkdir(RECOMMENDATIONS_DIR_PATH);
    }
}

function validateEvent(value: unknown): ReviewActionEvent {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.recommendationId !== "string"
        || (value.action !== "dismissed" && value.action !== "deferred" && value.action !== "completed" && value.action !== "restored")
        || typeof value.occurredAt !== "number" || !Number.isFinite(value.occurredAt)
        || (value.deferUntil !== undefined && (typeof value.deferUntil !== "number" || !Number.isFinite(value.deferUntil)))
        || (value.note !== undefined && typeof value.note !== "string")) {
        throw new Error("Review action 事件格式无效。");
    }
    return {
        id: value.id,
        recommendationId: value.recommendationId,
        action: value.action,
        occurredAt: value.occurredAt,
        ...(value.deferUntil === undefined ? {} : { deferUntil: value.deferUntil }),
        ...(value.note === undefined ? {} : { note: value.note }),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
