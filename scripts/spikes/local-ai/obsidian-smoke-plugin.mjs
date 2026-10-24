import { Modal, Notice, Plugin, Setting, apiVersion, normalizePath } from "obsidian";

const CONFIG = globalThis.__M4_CONFIG__;

export default class VaultCoachM4SmokePlugin extends Plugin {
    activeWorker = null;
    activeTimeoutId = null;
    activeRun = null;

    async onload() {
        this.addCommand({
            id: "run-wasm-download-smoke",
            name: "M4 smoke: Download model and run with WASM",
            callback: () => this.confirmAndRun("wasm"),
        });
        this.addCommand({
            id: "run-webgpu-download-smoke",
            name: "M4 smoke: Download model and run with WebGPU",
            callback: () => this.confirmAndRun("webgpu"),
        });
        this.addCommand({
            id: "run-wasm-offline-smoke",
            name: "M4 smoke: Verify WASM cache offline",
            callback: () => this.runSmoke({ device: "wasm", allowDownload: false }),
        });
        this.addCommand({
            id: "run-webgpu-offline-smoke",
            name: "M4 smoke: Verify WebGPU cache offline",
            callback: () => this.runSmoke({ device: "webgpu", allowDownload: false }),
        });
        this.addCommand({
            id: "cancel-active-smoke",
            name: "M4 smoke: Cancel active run",
            checkCallback: (checking) => {
                if (!this.activeWorker) return false;
                if (!checking) void this.cancelActiveRun();
                return true;
            },
        });
    }

    onunload() {
        this.activeWorker?.terminate();
        if (this.activeTimeoutId !== null) window.clearTimeout(this.activeTimeoutId);
        this.activeWorker = null;
        this.activeTimeoutId = null;
        this.activeRun = null;
    }

    confirmAndRun(device) {
        new ModelDownloadConsentModal(this.app, CONFIG, () => {
            void this.runSmoke({ device, allowDownload: true });
        }).open();
    }

    async runSmoke({ device, allowDownload }) {
        if (this.activeWorker) {
            new Notice("M4 smoke is already running.");
            return;
        }
        const pluginDirectory = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
        const getResource = (name) => this.app.vault.adapter.getResourcePath(normalizePath(`${pluginDirectory}/${name}`));
        const jsep = device === "webgpu" ? ".jsep" : "";
        const worker = new Worker(getResource("worker-smoke.js"));
        this.activeWorker = worker;
        new Notice(`M4 ${device.toUpperCase()} smoke started. Open Developer Tools for progress.`);
        const timeoutId = window.setTimeout(() => {
            void this.timeoutActiveRun();
        }, 15 * 60 * 1000);
        this.activeTimeoutId = timeoutId;
        this.activeRun = { device, allowDownload, startedAt: new Date().toISOString() };
        worker.onmessage = (event) => {
            const message = event.data;
            if (message?.type === "progress") {
                console.info("[VaultCoach M4]", message.payload);
                return;
            }
            if (message?.type === "result") void this.finishRun(worker, timeoutId, message.payload);
        };
        worker.onerror = (event) => {
            void this.finishRun(worker, timeoutId, {
                schemaVersion: 1,
                status: "fail",
                error: { name: "WorkerError", message: event.message || "Worker failed before returning a result." },
            });
        };
        worker.postMessage({
            type: "run",
            payload: {
                ...CONFIG,
                device,
                allowDownload,
                wasmPaths: {
                    mjs: getResource(`ort-wasm-simd-threaded${jsep}.mjs`),
                    wasm: getResource(`ort-wasm-simd-threaded${jsep}.wasm`),
                },
            },
        });
    }

    async finishRun(worker, timeoutId, payload) {
        window.clearTimeout(timeoutId);
        worker.terminate();
        if (this.activeWorker === worker) this.activeWorker = null;
        this.activeTimeoutId = null;
        this.activeRun = null;
        const result = {
            ...payload,
            recordedAt: new Date().toISOString(),
            obsidianVersion: apiVersion,
            platform: navigator.platform,
        };
        const directory = "vault-coach-m4-smoke-results";
        if (!(await this.app.vault.adapter.exists(directory))) await this.app.vault.adapter.mkdir(directory);
        const fileName = `run-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`;
        const target = normalizePath(`${directory}/${fileName}`);
        await this.app.vault.adapter.write(target, `${JSON.stringify(result, null, 2)}\n`);
        new Notice(`M4 smoke ${result.status}. Result saved to ${target}.`, 10000);
    }

    async cancelActiveRun() {
        const worker = this.activeWorker;
        const run = this.activeRun;
        if (!worker || !run) return;
        worker.terminate();
        if (this.activeTimeoutId !== null) window.clearTimeout(this.activeTimeoutId);
        this.activeWorker = null;
        this.activeTimeoutId = null;
        this.activeRun = null;
        const directory = "vault-coach-m4-smoke-results";
        if (!(await this.app.vault.adapter.exists(directory))) await this.app.vault.adapter.mkdir(directory);
        const target = normalizePath(`${directory}/run-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
        await this.app.vault.adapter.write(target, `${JSON.stringify({
            schemaVersion: 1,
            status: "cancelled",
            ...run,
            cancelledAt: new Date().toISOString(),
            obsidianVersion: apiVersion,
        }, null, 2)}\n`);
        new Notice(`M4 smoke cancelled. Result saved to ${target}.`, 10000);
    }

    async timeoutActiveRun() {
        const worker = this.activeWorker;
        const run = this.activeRun;
        if (!worker || !run) return;
        worker.terminate();
        this.activeWorker = null;
        this.activeTimeoutId = null;
        this.activeRun = null;
        const directory = "vault-coach-m4-smoke-results";
        if (!(await this.app.vault.adapter.exists(directory))) await this.app.vault.adapter.mkdir(directory);
        const target = normalizePath(`${directory}/run-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
        await this.app.vault.adapter.write(target, `${JSON.stringify({
            schemaVersion: 1,
            status: "timeout",
            ...run,
            timedOutAt: new Date().toISOString(),
            timeoutMs: 15 * 60 * 1000,
            obsidianVersion: apiVersion,
        }, null, 2)}\n`);
        new Notice(`M4 smoke timed out. Result saved to ${target}.`, 10000);
    }
}

class ModelDownloadConsentModal extends Modal {
    constructor(app, config, onConfirm) {
        super(app);
        this.config = config;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        this.setTitle("Run M4 model download smoke");
        this.contentEl.createEl("p", {
            text: `This experiment downloads ${this.config.repository}@${this.config.revision.slice(0, 8)} for local inference. Estimated weight file: ${Math.round(this.config.modelFileBytes / 1024 / 1024)} MiB.`,
        });
        this.contentEl.createEl("p", {
            text: "The candidate license is still pending manual verification. Run this only for technical evaluation, not redistribution.",
        });
        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
            .addButton((button) => button.setCta().setButtonText("Download and run").onClick(() => {
                this.close();
                this.onConfirm();
            }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
