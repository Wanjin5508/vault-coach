import { MarkdownRenderer, type App, type Component } from "obsidian";
import { normalizeObsidianMarkdown } from "../../markdown-normalizer";
import type { AnswerSource } from "../../domain/retrieval/retrieval-types";
import type { TranslationKey } from "../../i18n";

type TranslateFn = (key: TranslationKey, replacements?: Record<string, string | number>) => string;

export interface SourceListOptions {
    app: App;
    component: Component;
    containerEl: HTMLDivElement;
    sources: AnswerSource[];
    collapseByDefault: boolean;
    sourcePath: string;
    t: TranslateFn;
    openSource(source: AnswerSource): Promise<void>;
}

/** Renders the reusable source disclosure list below an assistant answer. */
export async function renderSourceList(options: SourceListOptions): Promise<void> {
    const detailsEl: HTMLDetailsElement = options.containerEl.createEl("details", {
        cls: "vault-coach-source-details",
    });

    if (!options.collapseByDefault) {
        detailsEl.open = true;
    }

    detailsEl.createEl("summary", {
        text: options.t("view.sources", { count: options.sources.length }),
    });

    for (const source of options.sources) {
        const itemEl: HTMLDivElement = detailsEl.createDiv({ cls: "vault-coach-source-item" });
        const linkButtonEl: HTMLButtonElement = itemEl.createEl("button", {
            cls: "vault-coach-source-link",
        });
        const linkMarkdownEl: HTMLSpanElement = linkButtonEl.createSpan({
            cls: "vault-coach-source-link-markdown markdown-rendered",
        });
        await renderSourceMarkdown(
            options.app,
            options.component,
            formatSourceDisplayLink(source, options.t),
            linkMarkdownEl,
            options.sourcePath,
            options.t,
        );

        linkButtonEl.addEventListener("click", () => {
            void options.openSource(source);
        });

        const excerptEl: HTMLDivElement = itemEl.createDiv({
            cls: "vault-coach-source-excerpt markdown-rendered",
        });
        await renderSourceMarkdown(
            options.app,
            options.component,
            source.excerpt,
            excerptEl,
            options.sourcePath,
            options.t,
        );
    }
}

async function renderSourceMarkdown(
    app: App,
    component: Component,
    markdown: string,
    containerEl: HTMLElement,
    sourcePath: string,
    t: TranslateFn,
): Promise<void> {
    const safeMarkdown = sanitizeSourceMarkdown(normalizeObsidianMarkdown(markdown));

    try {
        await MarkdownRenderer.render(app, safeMarkdown, containerEl, sourcePath, component);
    } catch (error: unknown) {
        console.error(t("view.sourceMarkdownFallback"), error);
        containerEl.empty();
        containerEl.setText(markdown);
    }
}

function formatSourceDisplayLink(source: AnswerSource, t: TranslateFn): string {
    if (source.locator?.type !== "pdf" || source.pageStart === undefined) {
        return source.displayLink;
    }

    const pageStart = source.pageStart;
    const pageEnd = source.pageEnd ?? source.pageStart;
    const pageLabel = pageEnd === pageStart
        ? t("view.source.pdfPage", { page: pageStart })
        : t("view.source.pdfPages", { start: pageStart, end: pageEnd });
    const fileName = source.filePath.split("/").pop() ?? source.filePath;

    return `[[${source.filePath}#page=${pageStart}|${fileName} · ${pageLabel}]]`;
}

function sanitizeSourceMarkdown(markdown: string): string {
    return markdown
        .replace(/```[ \t]*mermaid\b/gi, "```text")
        .replace(/~~~[ \t]*mermaid\b/gi, "~~~text");
}
