import type { ProgressApplicationApi } from "../../app/application-api";
import type { ProgressSnapshot, ProgressStateView } from "../../app/progress/progress-types";

/**
 * Stable presentation boundary for the Progress workspace.
 *
 * The controller forwards the grouped Application facade only. It never knows
 * how a snapshot is persisted, calculated, or rendered as DOM.
 */
export interface ProgressViewState extends ProgressStateView {
    available: boolean;
}

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
        // The current controller owns no subscription. Keep this lifecycle seam
        // so a future View-specific subscription can be released centrally.
    }
}
