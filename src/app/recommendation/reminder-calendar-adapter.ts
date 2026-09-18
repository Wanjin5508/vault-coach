/**
 * Future, opt-in boundary for an explicit calendar/reminder export.
 *
 * Lite deliberately provides no implementation: it must never create a
 * third-party account, send a network request, or schedule a background task
 * merely because a recommendation was generated.
 */
export interface RecommendationReminderRequest {
    recommendationId: string;
    title: string;
    dueAt: number | null;
    markdown: string;
}

export interface RecommendationReminderCalendarAdapter {
    readonly id: string;
    isAvailable(): Promise<boolean>;
    createReminder(request: RecommendationReminderRequest): Promise<void>;
}
