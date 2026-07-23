import type { ProgressApplicationApi } from "../../app/application-api";

/**
 * Stable presentation boundary for the future Progress feature.
 *
 * Milestone 0 deliberately exposes no progress data or user-facing entry.
 * Keeping the availability decision here prevents future Progress work from
 * leaking into the Chat or Exam controllers.
 */
export interface ProgressViewState {
    available: boolean;
}

export class ProgressController {
    constructor(private readonly api: ProgressApplicationApi) {}

    isAvailable(): boolean {
        return this.api.isAvailable();
    }

    getState(): ProgressViewState {
        return { available: this.isAvailable() };
    }

    dispose(): void {
        // Reserved for Progress subscriptions introduced in milestone 5.
    }
}
