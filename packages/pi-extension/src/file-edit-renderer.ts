import { diffWords } from "diff";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";

import type { JsonValue } from "@portable-devshell/shared";

import type {
    PiThemeLike,
    PiToolRenderContextLike,
    PiToolRenderResultLike,
    PiToolRenderResultOptionsLike
} from "./renderer.js";

const writeCollapsedLineLimit = 10;

type EditOperationKind = "delete" | "move" | "patch" | "rewrite" | "write";

export interface ParsedEditOperation {
    body: string;
    kind: EditOperationKind;
    path: string;
    source?: string;
}

type DiffEntry =
    | { kind: "ellipsis" }
    | { content: string; kind: "row"; line: number; prefix: "+" | "-" | " " };

export function renderFileEditCallComponent(
    args: unknown,
    theme: PiThemeLike,
    context: PiToolRenderContextLike
): Component {
    const changes = stringField(asRecord(args) ?? {}, "changes") ?? "";
    const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
    component.clear();
    buildCallComponent(component, parseEditChangeSet(changes), theme, context.expanded);
    return component;
}

export function renderFileEditResultComponent(
    result: PiToolRenderResultLike,
    _options: PiToolRenderResultOptionsLike,
    theme: PiThemeLike,
    context: PiToolRenderContextLike
): Component {
    const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
    component.clear();
    if (context.isError || detailsHaveFailure(result.details)) {
        const lines = textContentLines(result);
        if (lines.length > 0) {
            component.addChild(new Text(lines.map((line) => theme.fg("error", line)).join("\n"), 0, 0));
        }
        return component;
    }

    const operations = parseEditChangeSet(stringField(asRecord(context.args) ?? {}, "changes"));
    const results = operationRecords(result.details);
    let rendered = false;
    for (const [index, operation] of operations.entries()) {
        if (operation.kind === "write" || operation.kind === "rewrite") continue;
        const operationResult = results[index];
        const diff = operationResult === undefined ? undefined : stringField(operationResult, "diff");
        if (diff === undefined) continue;
        if (rendered) component.addChild(new Spacer(1));
        component.addChild(new Text(renderWorkerUnifiedDiff(diff, theme), 0, 0));
        rendered = true;
    }
    return component;
}

export function formatFileEditStaticCall(changes: string | undefined, theme?: PiThemeLike): string {
    const operations = parseEditChangeSet(changes);
    if (operations.length === 0) return style(theme, "toolTitle", "file_edit", true);
    return operations.map((operation) => staticHeader(operation, theme)).join("\n");
}

export function renderFileEditFallback(value: JsonValue | undefined, theme?: PiThemeLike): string[] {
    if (theme === undefined) return [];
    const lines: string[] = [];
    for (const operation of operationRecords(value)) {
        const diff = stringField(operation, "diff");
        if (diff !== undefined) lines.push(renderWorkerUnifiedDiff(diff, theme));
        const error = asRecord(operation.error);
        const message = error === undefined ? undefined : stringField(error, "message");
        if (message !== undefined) lines.push(message);
    }
    return lines;
}

export function parseEditChangeSet(changes: string | undefined): ParsedEditOperation[] {
    if (changes === undefined) return [];
    const lines = changes.split("\n");
    const operations: ParsedEditOperation[] = [];
    let index = 0;
    while (index < lines.length) {
        const match = lines[index]!.match(/^\*\*\* (Write|Patch|Rewrite|Delete|Move) File: (.+)$/u);
        if (match === null) {
            index += 1;
            continue;
        }
        const kind = match[1]!.toLowerCase() as EditOperationKind;
        const firstPath = match[2]!;
        index += 1;
        let source: string | undefined;
        let path = firstPath;
        if (kind === "move") {
            source = firstPath;
            const target = lines[index]?.match(/^\*\*\* To: (.+)$/u)?.[1];
            if (target !== undefined) {
                path = target;
                index += 1;
            }
        }
        const body: string[] = [];
        while (index < lines.length) {
            const line = lines[index]!;
            if (/^\*\*\* (?:Write|Patch|Rewrite|Delete|Move) File: /u.test(line) || line === "*** End Edit") break;
            body.push(line);
            index += 1;
        }
        operations.push({ body: body.join("\n").replace(/\n$/u, ""), kind, path, ...(source === undefined ? {} : { source }) });
    }
    return operations;
}

export function renderWorkerUnifiedDiff(diff: string, theme: PiThemeLike): string {
    const entries = parseUnifiedDiff(diff);
    const rows = entries.filter((entry): entry is Extract<DiffEntry, { kind: "row" }> => entry.kind === "row");
    const width = Math.max(1, ...rows.map((row) => String(row.line).length));
    const output: string[] = [];
    let index = 0;
    while (index < entries.length) {
        const entry = entries[index]!;
        if (entry.kind === "ellipsis") {
            output.push(theme.fg("toolDiffContext", ` ${"".padStart(width, " ")} ...`));
            index += 1;
            continue;
        }
        if (entry.prefix === "-") {
            const removed: Array<Extract<DiffEntry, { kind: "row" }>> = [];
            while (index < entries.length) {
                const current = entries[index]!;
                if (current.kind !== "row" || current.prefix !== "-") break;
                removed.push(current);
                index += 1;
            }
            const added: Array<Extract<DiffEntry, { kind: "row" }>> = [];
            while (index < entries.length) {
                const current = entries[index]!;
                if (current.kind !== "row" || current.prefix !== "+") break;
                added.push(current);
                index += 1;
            }
            if (removed.length === 1 && added.length === 1) {
                const intraline = renderIntraLineDiff(removed[0]!.content, added[0]!.content, theme);
                output.push(theme.fg("toolDiffRemoved", `-${String(removed[0]!.line).padStart(width, " ")} ${intraline.removed}`));
                output.push(theme.fg("toolDiffAdded", `+${String(added[0]!.line).padStart(width, " ")} ${intraline.added}`));
            } else {
                for (const row of removed) output.push(renderDiffRow(row, width, theme));
                for (const row of added) output.push(renderDiffRow(row, width, theme));
            }
            continue;
        }
        output.push(renderDiffRow(entry, width, theme));
        index += 1;
    }
    return output.join("\n");
}

function buildCallComponent(
    component: Container,
    operations: ParsedEditOperation[],
    theme: PiThemeLike,
    expanded: boolean
): void {
    for (const [index, operation] of operations.entries()) {
        if (index > 0) component.addChild(new Spacer(1));
        component.addChild(new Text(renderHeader(operation, theme), 0, 0));
        const body = renderOperationBody(operation, expanded, theme);
        if (body.length > 0) {
            component.addChild(new Spacer(1));
            component.addChild(new Text(body, 0, 0));
        }
    }
}

function renderHeader(operation: ParsedEditOperation, theme: PiThemeLike): string {
    const { label, path } = displayIdentity(operation);
    return `${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("toolOutput", path)}`;
}

function staticHeader(operation: ParsedEditOperation, theme?: PiThemeLike): string {
    const { label, path } = displayIdentity(operation);
    return joinCall(style(theme, "toolTitle", label, true), [path], theme);
}

function displayIdentity(operation: ParsedEditOperation): { label: string; path: string } {
    const label = operation.kind === "write" || operation.kind === "rewrite"
        ? "write"
        : operation.kind === "patch"
            ? "edit"
            : operation.kind;
    const path = operation.kind === "move" && operation.source !== undefined
        ? `${operation.source} → ${operation.path}`
        : operation.path;
    return { label, path };
}

function renderOperationBody(
    operation: ParsedEditOperation,
    expanded: boolean,
    theme: PiThemeLike
): string {
    if (operation.kind === "write" || operation.kind === "rewrite") {
        return renderWritePreview(operation.path, operation.body, expanded, theme);
    }
    return "";
}

function renderWritePreview(path: string, content: string, expanded: boolean, theme: PiThemeLike): string {
    if (content.length === 0) return "";
    const normalized = content.replace(/\t/gu, "   ");
    const language = getLanguageFromPath(path);
    const lines = language === undefined ? normalized.split("\n") : highlightCode(normalized, language);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const limit = expanded ? lines.length : writeCollapsedLineLimit;
    const visible = lines.slice(0, limit);
    const remaining = lines.length - visible.length;
    const rendered = visible.map((line) => language === undefined ? theme.fg("toolOutput", line) : line);
    if (remaining > 0) {
        rendered.push(theme.fg("muted", `... (${remaining} more lines, ${lines.length} total, Ctrl+O to expand)`));
    }
    return rendered.join("\n");
}

function parseUnifiedDiff(diff: string): DiffEntry[] {
    const entries: DiffEntry[] = [];
    let oldLine = 0;
    let newLine = 0;
    let sawHunk = false;
    for (const line of diff.replace(/\n$/u, "").split("\n")) {
        if (line.startsWith("--- ") || line.startsWith("+++ ") || line === "\\ No newline at end of file") continue;
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
        if (hunk !== null) {
            if (sawHunk) entries.push({ kind: "ellipsis" });
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            sawHunk = true;
            continue;
        }
        if (!sawHunk || line.length === 0) continue;
        const prefix = line[0];
        const content = line.slice(1).replace(/\t/gu, "   ");
        if (prefix === " ") {
            entries.push({ content, kind: "row", line: oldLine, prefix: " " });
            oldLine += 1;
            newLine += 1;
        } else if (prefix === "-") {
            entries.push({ content, kind: "row", line: oldLine, prefix: "-" });
            oldLine += 1;
        } else if (prefix === "+") {
            entries.push({ content, kind: "row", line: newLine, prefix: "+" });
            newLine += 1;
        }
    }
    return entries;
}

function renderDiffRow(row: Extract<DiffEntry, { kind: "row" }>, width: number, theme: PiThemeLike): string {
    const role = row.prefix === "+" ? "toolDiffAdded" : row.prefix === "-" ? "toolDiffRemoved" : "toolDiffContext";
    return theme.fg(role, `${row.prefix}${String(row.line).padStart(width, " ")} ${row.content}`);
}

function renderIntraLineDiff(oldContent: string, newContent: string, theme: PiThemeLike): { added: string; removed: string } {
    const parts = diffWords(oldContent, newContent);
    let removed = "";
    let added = "";
    let firstRemoved = true;
    let firstAdded = true;
    for (const part of parts) {
        if (part.removed) {
            let value = part.value;
            if (firstRemoved) {
                const leading = value.match(/^(\s*)/u)?.[1] ?? "";
                removed += leading;
                value = value.slice(leading.length);
                firstRemoved = false;
            }
            if (value.length > 0) removed += theme.inverse(value);
        } else if (part.added) {
            let value = part.value;
            if (firstAdded) {
                const leading = value.match(/^(\s*)/u)?.[1] ?? "";
                added += leading;
                value = value.slice(leading.length);
                firstAdded = false;
            }
            if (value.length > 0) added += theme.inverse(value);
        } else {
            removed += part.value;
            added += part.value;
        }
    }
    return { added, removed };
}

function operationRecords(value: JsonValue | undefined): Array<Record<string, unknown>> {
    const record = asRecord(value);
    return record !== undefined && Array.isArray(record.operations)
        ? record.operations.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined)
        : [];
}

function detailsHaveFailure(value: JsonValue | undefined): boolean {
    return operationRecords(value).some((operation) => operation.status === "failed");
}

function textContentLines(result: PiToolRenderResultLike): string[] {
    return result.content
        .filter((entry) => entry.type === "text" && typeof entry.text === "string")
        .flatMap((entry) => entry.text!.split("\n"));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
    return typeof record[key] === "string" ? record[key] : undefined;
}

function joinCall(title: string, values: Array<string | undefined>, theme?: PiThemeLike): string {
    return [title, ...values
        .filter((value): value is string => value !== undefined && value.length > 0)
        .map((value) => style(theme, "toolOutput", value))].join(" ");
}

function style(theme: PiThemeLike | undefined, role: string, text: string, bold = false): string {
    if (theme === undefined) return text;
    return theme.fg(role, bold ? theme.bold(text) : text);
}
