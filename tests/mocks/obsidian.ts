/**
 * Minimal Obsidian runtime substitute for unit tests.
 *
 * Production bundling continues to externalize the real `obsidian` module.
 */
export class App {}

export class TFile {
    path = "";
    extension = "";
}

export function normalizePath(path: string): string {
    return path
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\//, "")
        .replace(/\/$/, "");
}
