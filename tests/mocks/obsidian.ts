/**
 * Minimal Obsidian runtime substitute for unit tests.
 *
 * Production bundling continues to externalize the real `obsidian` module.
 */
export class App {}

export class PluginSettingTab {
    constructor(_app: App, _plugin: unknown) {}

    update(): void {}
}

export class ItemView {
    contentEl = {
        empty: (): void => undefined,
    } as unknown as HTMLElement;

    constructor(_leaf: unknown) {}
}

export class Notice {
    constructor(_message: string) {}
}

export class Setting {}

export class DropdownComponent {}

export class SecretComponent {}

export class TFile {
    path = "";
    extension = "";
    basename = "";
    stat = {
        size: 0,
        mtime: 0,
    };
}

export function normalizePath(path: string): string {
    return path
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\//, "")
        .replace(/\/$/, "");
}
