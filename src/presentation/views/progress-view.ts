import type { ProgressViewState } from "../controllers/progress-controller";

/**
 * Rendering seam for the future Progress feature.
 *
 * It intentionally renders nothing while Progress is unavailable, so M0 does
 * not introduce an empty dashboard or alter the existing mode switch.
 */
export class ProgressView {
    render(_rootEl: HTMLDivElement, _state: Readonly<ProgressViewState>): void {
        // The Progress UI is introduced only when ProgressController reports availability.
    }

    dispose(): void {
        // Reserved for Progress DOM resources introduced in milestone 5.
    }
}
