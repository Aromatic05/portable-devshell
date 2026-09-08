import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { JsonValue } from "@portable-devshell/shared";

import type { PiThemeLike, PiToolRenderResultLike } from "./renderer-types.js";

export class OutputPreviewComponent implements Component {
    #expanded = false;
    #footer: string[] = [];
    #lines: string[] = [];
    #tailLines = 5;
    #theme?: PiThemeLike;

    setState(state: { expanded: boolean; footer: string[]; lines: string[]; tailLines: number; theme?: PiThemeLike }): void {
        this.#expanded = state.expanded;
        this.#footer = state.footer;
        this.#lines = state.lines;
        this.#tailLines = state.tailLines;
        this.#theme = state.theme;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const output: string[] = [];
        const visible = this.#expanded ? this.#lines : this.#lines.slice(-this.#tailLines);
        const skipped = this.#lines.length - visible.length;
        if (visible.length > 0 || this.#footer.length > 0) output.push("");
        if (!this.#expanded && skipped > 0) {
            output.push(truncateToWidth(style(this.#theme, "muted", `... (${skipped} earlier lines, Ctrl+O to expand)`), width, "..."));
        }
        output.push(...visible.map((line) => truncateToWidth(line, width, "...")));
        output.push(...this.#footer.map((line) => truncateToWidth(line, width, "...")));
        return output;
    }
}

export function clearComponent(component: Component | undefined): Component {
    const container = component instanceof Container ? component : new Container();
    container.clear();
    return container;
}

export function setText(component: Component | undefined, text: string): Component {
    if (component instanceof Text) {
        component.setText(text);
        return component;
    }
    return new Text(text, 0, 0);
}

export function renderError(result: PiToolRenderResultLike, theme?: PiThemeLike): string {
    const lines = textContentLines(result);
    const fallback = lines.length === 0 ? renderStructured(result.details) : lines;
    return fallback.map((line) => style(theme, "error", line)).join("\n");
}

export function joinStyled(lines: string[], theme?: PiThemeLike): string {
    return lines.map((line) => style(theme, "toolOutput", line)).join("\n");
}

export function joinCall(title: string, values: Array<string | undefined>, theme?: PiThemeLike): string {
    return [title, ...values
        .filter((value): value is string => value !== undefined && value.length > 0)
        .map((value) => style(theme, "toolOutput", value))].join(" ");
}

export function summarizeRecord(record: Record<string, unknown>): Array<string | undefined> {
    return Object.entries(record)
        .filter(([key]) => !["ctxId", "instance"].includes(key))
        .slice(0, 4)
        .map(([key, value]) => {
            const preview = previewScalar(value);
            return preview === undefined ? undefined : `${key}=${preview}`;
        });
}

export function renderStructured(value: JsonValue | undefined): string[] {
    if (value === undefined || value === null) return [];
    if (typeof value !== "object") return [String(value)];
    if (Array.isArray(value)) {
        return value.flatMap((entry) => {
            const nested = renderStructured(entry);
            return nested.length === 0 ? [] : [`• ${nested[0]}`, ...nested.slice(1).map((line) => `  ${line}`)];
        });
    }
    const lines: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined || entry === null) continue;
        if (typeof entry !== "object") lines.push(`${key}: ${oneLine(String(entry), 240)}`);
        else {
            lines.push(`${key}:`);
            lines.push(...renderStructured(entry as JsonValue).map((line) => `  ${line}`));
        }
    }
    return lines;
}

export function textContentLines(result: PiToolRenderResultLike): string[] {
    return result.content
        .filter((entry) => entry.type === "text" && typeof entry.text === "string")
        .flatMap((entry) => entry.text!.split("\n"));
}

export function tailWithHint(lines: string[], limit: number): string[] {
    if (lines.length <= limit) return [...lines];
    return [`... (${lines.length - limit} earlier lines, Ctrl+O to expand)`, ...lines.slice(-limit)];
}

export function clipHead(lines: string[], limit: number): string[] {
    return lines.length <= limit ? [...lines] : [...lines.slice(0, limit), `... (${lines.length - limit} more lines, Ctrl+O to expand)`];
}

export function splitOutput(value: string): string[] {
    return value.length === 0 ? [] : value.replace(/\n$/u, "").split("\n");
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
    return typeof record[key] === "string" ? record[key] : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
    return typeof record[key] === "number" ? record[key] : undefined;
}

export function stringArrayField(record: Record<string, unknown>, key: string): string[] {
    return stringList(record[key]);
}

export function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : typeof value === "string" ? value.split("\n") : [];
}

export function option(record: Record<string, unknown>, key: string): string | undefined {
    const value = previewScalar(record[key]);
    return value === undefined ? undefined : `${key}=${value}`;
}

export function previewInput(value: unknown): string | undefined {
    if (Array.isArray(value)) {
        const preview = value.filter((entry): entry is string => typeof entry === "string").join("");
        return preview.length === 0 ? undefined : oneLine(preview, 80);
    }
    return previewScalar(value);
}

export function previewScalar(value: unknown): string | undefined {
    if (typeof value === "string") return oneLine(value, 80);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return undefined;
}

export function oneLine(value: string, limit: number): string {
    const flattened = value.replace(/\s+/gu, " ").trim();
    return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1)}…`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

export function style(theme: PiThemeLike | undefined, role: string, text: string, bold = false): string {
    if (theme === undefined) return text;
    return theme.fg(role, bold ? theme.bold(text) : text);
}
