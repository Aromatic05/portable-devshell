import { highlightCode } from "@earendil-works/pi-coding-agent";

import type { JsonValue } from "@portable-devshell/shared";

import type {
    PiThemeLike,
    PiToolRenderContextLike,
    PiToolRenderResultLike,
    PiToolRenderResultOptionsLike
} from "./renderer-types.js";
import {
    asRecord,
    clearComponent,
    clipHead,
    formatBytes,
    joinCall,
    numberField,
    setText,
    stringArrayField,
    stringField,
    style,
    textContentLines
} from "./renderer-utils.js";

export function formatArtifactCall(record: Record<string, unknown>, theme?: PiThemeLike): string {
    const title = style(theme, "toolTitle", "artifact", true);
    const handle = stringField(record, "handle");
    const offset = numberField(record, "offsetBytes");
    const encoding = stringField(record, "encoding");
    return joinCall(title, [
        handle,
        offset === undefined || offset === 0 ? undefined : `@${offset}`,
        encoding === undefined || encoding === "utf8" ? undefined : encoding
    ], theme);
}

export function formatReadCall(record: Record<string, unknown>, theme?: PiThemeLike): string {
    const title = style(theme, "toolTitle", "read", true);
    const files = record.files;
    if (Array.isArray(files)) {
        const requests = files.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined);
        if (requests.length === 1) return formatReadRequest(title, requests[0]!, theme);
        const paths = requests.map((entry) => stringField(entry, "path")).filter((value): value is string => value !== undefined);
        const preview = paths.length <= 3 ? paths.join(", ") : `${paths.slice(0, 3).join(", ")} +${paths.length - 3}`;
        return joinCall(title, [`${requests.length} files`, preview || undefined], theme);
    }
    return formatReadRequest(title, record, theme);
}

export function formatSearchCall(record: Record<string, unknown>, theme?: PiThemeLike): string {
    const title = style(theme, "toolTitle", "grep", true);
    const pattern = stringField(record, "pattern");
    const paths = stringArrayField(record, "paths");
    const syntax = stringField(record, "syntax");
    const patternDisplay = pattern === undefined
        ? undefined
        : syntax === "literal" ? JSON.stringify(pattern) : `/${pattern}/`;
    return joinCall(title, [
        patternDisplay,
        paths.length === 0 ? "in ." : `in ${paths.join(", ")}`,
        numberField(record, "context") === undefined ? undefined : `context ${numberField(record, "context")}`
    ], theme);
}

export function formatFindCall(record: Record<string, unknown>, theme?: PiThemeLike): string {
    const title = style(theme, "toolTitle", "find", true);
    if (typeof record.cursor === "string") return joinCall(title, ["next page"], theme);
    const paths = stringArrayField(record, "paths");
    const type = stringField(record, "type");
    return joinCall(title, [paths.length === 0 ? "." : paths.join(", "), type === undefined || type === "any" ? undefined : type], theme);
}

export function formatInfoCall(record: Record<string, unknown>, theme?: PiThemeLike): string {
    const title = style(theme, "toolTitle", "stat", true);
    const paths = stringArrayField(record, "paths");
    return joinCall(title, [paths.length === 0 ? undefined : paths.join(", "), record.details === true ? "details" : undefined], theme);
}

export function renderFileReadComponent(
    result: PiToolRenderResultLike,
    options: PiToolRenderResultOptionsLike,
    theme: PiThemeLike,
    context: PiToolRenderContextLike
) {
    if (!options.expanded) return clearComponent(context.lastComponent);
    const sections = fileReadSections(result.details, context.args);
    const rendered: string[] = [];
    for (const [index, section] of sections.entries()) {
        if (index > 0) rendered.push("");
        if (sections.length > 1 && section.path !== undefined) {
            rendered.push(`${style(theme, "toolTitle", "read", true)} ${style(theme, "accent", section.path)}`);
        }
        rendered.push(...highlightNumberedContent(section.content, section.language, theme));
        rendered.push(...renderReadWarnings(section, theme));
    }
    return setText(context.lastComponent, rendered.length === 0 ? textContentLines(result).join("\n") : `\n${rendered.join("\n")}`);
}

export function renderFileRead(value: JsonValue | undefined, expanded: boolean): string[] {
    if (!expanded) return [];
    const sections = fileReadSections(value);
    const lines: string[] = [];
    for (const [index, section] of sections.entries()) {
        if (index > 0) lines.push("");
        if (sections.length > 1 && section.path !== undefined) lines.push(`read ${section.path}`);
        lines.push(...section.content.split("\n"));
        if (section.nextSelector !== undefined) lines.push(`[More available: selector ${section.nextSelector}]`);
        else if (section.truncated) lines.push("[Truncated]");
        if (section.parseStatus === "partial") lines.push("[Partial parse]");
    }
    return lines;
}

export function renderFileSearch(value: JsonValue | undefined, expanded: boolean): string[] {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record.files)) return [];
    const lines: string[] = [];
    for (const entry of record.files) {
        const file = asRecord(entry);
        if (file === undefined) continue;
        const path = stringField(file, "path");
        const content = stringField(file, "content");
        if (path !== undefined) lines.push(path);
        if (content !== undefined) lines.push(...content.split("\n").map((line) => `  ${line}`));
        if (file.truncated === true) {
            const nextLine = numberField(file, "nextLine");
            lines.push(`  [More matches${nextLine === undefined ? "" : ` from line ${nextLine}`}]`);
        }
    }
    if (typeof record.nextCursor === "string") lines.push("[More results available: continue with next cursor]");
    return clipHead(lines, expanded ? 160 : 15);
}

export function renderFileFind(value: JsonValue | undefined, expanded: boolean): string[] {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record.entries)) return [];
    const lines = record.entries.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined).map((entry) => {
        const path = stringField(entry, "path") ?? "?";
        return stringField(entry, "type") === "directory" && !path.endsWith("/") ? `${path}/` : path;
    });
    if (typeof record.nextCursor === "string") lines.push("[More results available: continue with next cursor]");
    return clipHead(lines, expanded ? 160 : 20);
}

export function renderFileInfo(value: JsonValue | undefined): string[] {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record.entries)) return [];
    return record.entries.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined).map((entry) => {
        const path = stringField(entry, "path") ?? "?";
        if (entry.exists === false) return `${path} · missing`;
        const type = stringField(entry, "type") ?? "unknown";
        const target = stringField(entry, "targetType");
        const size = numberField(entry, "sizeBytes");
        const mode = numberField(entry, "mode");
        return [
            path,
            type === "symlink" && target !== undefined ? `symlink→${target}` : type,
            size === undefined ? undefined : formatBytes(size),
            mode === undefined ? undefined : `0${mode.toString(8).slice(-3)}`
        ].filter((item): item is string => item !== undefined).join(" · ");
    });
}

export function renderArtifactResult(value: JsonValue | undefined, expanded: boolean): string[] {
    const record = asRecord(value);
    if (record === undefined) return [];
    const content = stringField(record, "content") ?? "";
    const lines = content.length === 0 ? [] : content.replace(/\n$/u, "").split("\n");
    const clipped = clipHead(lines, expanded ? 160 : 12);
    const next = numberField(record, "nextOffsetBytes");
    if (next !== undefined) clipped.push(`[More available: offsetBytes=${next}]`);
    if (record.lossy === true) clipped.push("[Lossy UTF-8 decoding]");
    if (record.artifactTruncated === true) clipped.push("[Artifact truncated at capture time]");
    return clipped;
}

export function renderFileSummaryComponent(
    toolName: "artifact_read" | "file_find" | "file_info" | "file_search",
    result: PiToolRenderResultLike,
    options: PiToolRenderResultOptionsLike,
    theme: PiThemeLike,
    context: PiToolRenderContextLike
) {
    const lines = toolName === "artifact_read"
        ? renderArtifactResult(result.details, options.expanded)
        : toolName === "file_find"
            ? renderFileFind(result.details, options.expanded)
            : toolName === "file_info"
                ? renderFileInfo(result.details)
                : renderFileSearch(result.details, options.expanded);
    return setText(
        context.lastComponent,
        lines.map((line) => style(theme, line.trimStart().startsWith("[") ? "warning" : "toolOutput", line)).join("\n")
    );
}

function formatReadRequest(title: string, record: Record<string, unknown>, theme?: PiThemeLike): string {
    const path = stringField(record, "path");
    const selector = stringField(record, "selector");
    const view = stringField(record, "view");
    return joinCall(title, [
        path === undefined ? undefined : `${path}${selector === undefined ? "" : style(theme, "warning", `:${selector}`)}`,
        view === undefined || view === "auto" || view === "content" ? undefined : view
    ], theme);
}

interface FileReadSection {
    content: string;
    language?: string;
    nextSelector?: string;
    parseStatus?: string;
    path?: string;
    truncated: boolean;
}

function fileReadSections(value: JsonValue | undefined, args?: unknown): FileReadSection[] {
    const record = asRecord(value);
    if (record === undefined) return [];
    if (Array.isArray(record.files)) {
        return record.files.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined).map((entry) => ({
            content: stringField(entry, "content") ?? "",
            language: stringField(entry, "language"),
            nextSelector: stringField(entry, "nextSelector"),
            parseStatus: stringField(entry, "parseStatus"),
            path: stringField(entry, "path"),
            truncated: entry.truncated === true
        }));
    }
    const argRecord = asRecord(args);
    return [{
        content: stringField(record, "content") ?? "",
        language: stringField(record, "language"),
        nextSelector: stringField(record, "nextSelector"),
        parseStatus: stringField(record, "parseStatus"),
        path: argRecord === undefined ? undefined : stringField(argRecord, "path"),
        truncated: record.truncated === true
    }];
}

function highlightNumberedContent(content: string, language: string | undefined, theme: PiThemeLike): string[] {
    if (content.length === 0) return [];
    const parsed = content.split("\n").map((line) => {
        const match = line.match(/^(\d+):(.*)$/u);
        return match === null ? { code: line, line: undefined } : { code: match[2]!, line: match[1]! };
    });
    const resolvedLanguage = language === undefined || language === "text" ? undefined : language;
    const highlighted = resolvedLanguage === undefined
        ? parsed.map((entry) => style(theme, "toolOutput", entry.code.replace(/\t/gu, "   ")))
        : highlightCode(parsed.map((entry) => entry.code.replace(/\t/gu, "   ")).join("\n"), resolvedLanguage);
    const width = Math.max(1, ...parsed.map((entry) => entry.line?.length ?? 0));
    return highlighted.map((line, index) => {
        const lineNumber = parsed[index]?.line;
        return lineNumber === undefined ? line : `${style(theme, "muted", lineNumber.padStart(width, " "))} ${line}`;
    });
}

function renderReadWarnings(section: FileReadSection, theme: PiThemeLike): string[] {
    const lines: string[] = [];
    if (section.nextSelector !== undefined) lines.push(style(theme, "warning", `[More available: selector ${section.nextSelector}]`));
    else if (section.truncated) lines.push(style(theme, "warning", "[Truncated]"));
    if (section.parseStatus === "partial") lines.push(style(theme, "warning", "[Partial parse]"));
    return lines;
}
