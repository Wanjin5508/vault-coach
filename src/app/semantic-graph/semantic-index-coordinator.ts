import type { SemanticGraphBuildProgress } from "../../domain/semantic-graph/semantic-graph-types";

export type SemanticIndexProgress = SemanticGraphBuildProgress;

/** Serialises optional model work without sharing the text/vector index controller. */
export class SemanticIndexCoordinator {
    private controller: AbortController | null = null;
    private active = false;
    private progress: SemanticIndexProgress = { totalSections: 0, processedSections: 0, queuedSections: 0, failedSections: 0 };

    start(signal?: AbortSignal): AbortSignal | null {
        if (this.active) return null;
        this.controller = signal ? null : new AbortController();
        this.active = true;
        this.progress = { totalSections: 0, processedSections: 0, queuedSections: 0, failedSections: 0 };
        return signal ?? this.controller?.signal ?? null;
    }

    finish(): void {
        this.controller = null;
        this.active = false;
    }

    abort(): void {
        this.controller?.abort(new DOMException("VaultCoach semantic graph build aborted by user.", "AbortError"));
    }

    isBusy(): boolean {
        return this.active;
    }

    setProgress(progress: SemanticIndexProgress): void {
        this.progress = { ...progress };
    }

    getProgress(): SemanticIndexProgress {
        return { ...this.progress };
    }
}
