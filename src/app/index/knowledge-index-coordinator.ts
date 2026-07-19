import type { KnowledgeIndexBusyPhase, KnowledgeIndexBusyState } from "./index-types";

/** Owns the mutable state shared by rebuild, incremental sync, and cancellation. */
export class KnowledgeIndexCoordinator {
    private readonly onStateChanged: () => void;
    private textDirty = true;
    private vectorDirty = true;
    private busyState: KnowledgeIndexBusyState = {
        busy: false,
        phase: null,
        startedAt: null,
    };
    private activeAbortController: AbortController | null = null;

    constructor(onStateChanged: () => void) {
        this.onStateChanged = onStateChanged;
    }

    getTextDirty(): boolean {
        return this.textDirty;
    }

    setTextDirty(value: boolean): void {
        this.textDirty = value;
        this.onStateChanged();
    }

    getVectorDirty(): boolean {
        return this.vectorDirty;
    }

    setVectorDirty(value: boolean): void {
        this.vectorDirty = value;
        this.onStateChanged();
    }

    getBusyState(): KnowledgeIndexBusyState {
        return { ...this.busyState };
    }

    replaceBusyState(state: KnowledgeIndexBusyState): void {
        this.busyState = { ...state };
        this.onStateChanged();
    }

    setBusy(phase: KnowledgeIndexBusyPhase): void {
        this.busyState = {
            busy: true,
            phase,
            startedAt: this.busyState.startedAt ?? Date.now(),
        };
        this.onStateChanged();
    }

    setIdle(): void {
        if (!this.busyState.busy) {
            return;
        }

        this.busyState = { busy: false, phase: null, startedAt: null };
        this.onStateChanged();
    }

    getActiveAbortController(): AbortController | null {
        return this.activeAbortController;
    }

    setActiveAbortController(controller: AbortController | null): void {
        this.activeAbortController = controller;
    }

    dispose(): void {
        this.activeAbortController?.abort(new DOMException("VaultCoach index coordinator disposed.", "AbortError"));
        this.activeAbortController = null;
        this.setIdle();
    }
}
