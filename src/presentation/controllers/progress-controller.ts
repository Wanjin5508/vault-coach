import type { ProgressApplicationApi } from "../../app/application-api";
import type { ProgressSnapshot, ProgressStateView } from "../../app/progress/progress-types";

/**
 * Progress 工作区的稳定展示边界。
 *
 * Controller 只转发分组后的 Application 门面，不感知快照如何持久化、计算或渲染为 DOM。
 */
export interface ProgressViewState extends ProgressStateView {
    available: boolean;
}

/** Progress View 的薄适配器，只组合展示状态，不缓存或修改进度事实。 */
export class ProgressController {
    constructor(private readonly api: ProgressApplicationApi) {}

    isAvailable(): boolean {
        return this.api.isAvailable();
    }

    getState(): ProgressViewState {
        return {
            available: this.isAvailable(),
            ...this.api.getState(),
        };
    }

    getSnapshot(): Promise<ProgressSnapshot> {
        return this.api.getSnapshot();
    }

    dispose(): void {
        // 当前 Controller 不持有订阅。保留该生命周期接缝，便于未来集中释放 View 专属订阅。
    }
}
