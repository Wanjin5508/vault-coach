/**
 * 未来日历或提醒导出的显式授权边界。
 *
 * Lite 不提供默认实现。生成推荐本身不得创建第三方账户、发送网络请求或安排后台任务。
 */
export interface RecommendationReminderRequest {
    recommendationId: string;
    title: string;
    dueAt: number | null;
    markdown: string;
}

/** 第三方提醒服务端口；实现必须在调用前完成显式授权和可用性检查。 */
export interface RecommendationReminderCalendarAdapter {
    readonly id: string;
    isAvailable(): Promise<boolean>;
    createReminder(request: RecommendationReminderRequest): Promise<void>;
}
