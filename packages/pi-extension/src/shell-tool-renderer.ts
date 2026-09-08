import type { Component } from "@earendil-works/pi-tui";

import type { JsonValue } from "@portable-devshell/shared";

import type {
    PiThemeLike,
    PiToolRenderContextLike,
    PiToolRenderResultLike,
    PiToolRenderResultOptionsLike
} from "./renderer-types.js";
import {
    asRecord,
    formatDuration,
    numberField,
    oneLine,
    OutputPreviewComponent,
    setText,
    splitOutput,
    stringField,
    style,
    tailWithHint,
    textContentLines
} from "./renderer-utils.js";

export function formatShellCall(record: Record<string, unknown>, theme?: PiThemeLike): string {
    const command = stringField(record, "command");
    const display = command === undefined ? "$ ..." : `$ ${oneLine(command, 180)}`;
    const suffix = [
        stringField(record, "cwd") === undefined ? undefined : `in ${stringField(record, "cwd")}`,
        numberField(record, "timeoutMs") === undefined ? undefined : `timeout ${formatDuration(numberField(record, "timeoutMs")!)}`
    ].filter((value): value is string => value !== undefined).join(" · ");
    return [
        style(theme, "toolTitle", display, true),
        suffix.length === 0 ? undefined : style(theme, "muted", suffix)
    ].filter((value): value is string => value !== undefined).join(" ");
}

export function renderBashResultComponent(
    result: PiToolRenderResultLike,
    options: PiToolRenderResultOptionsLike,
    theme: PiThemeLike,
    context: PiToolRenderContextLike
): Component {
    const details = asRecord(result.details);
    if (details === undefined) return setText(context.lastComponent, textContentLines(result).join("\n"));
    const stdout = stringField(details, "stdout") ?? "";
    const stderr = stringField(details, "stderr") ?? "";
    const lines = [
        ...splitOutput(stdout).map((line) => style(theme, "toolOutput", line)),
        ...splitOutput(stderr).map((line) => style(theme, "error", line))
    ];
    const footer = bashFooter(details, theme);
    const component = context.lastComponent instanceof OutputPreviewComponent
        ? context.lastComponent
        : new OutputPreviewComponent();
    component.setState({ expanded: options.expanded, footer, lines, tailLines: 5, theme });
    return component;
}

export function renderBashResult(value: JsonValue | undefined, expanded: boolean): string[] {
    const record = asRecord(value);
    if (record === undefined) return [];
    const lines = [...splitOutput(stringField(record, "stdout") ?? ""), ...splitOutput(stringField(record, "stderr") ?? "")];
    const visible = expanded ? lines : tailWithHint(lines, 5);
    const footer = bashFooter(record);
    if (footer.length > 0) visible.push(...footer);
    return visible;
}

function bashFooter(record: Record<string, unknown>, theme?: PiThemeLike): string[] {
    const lines: string[] = [];
    const warnings: string[] = [];
    if (record.stdoutTruncated === true) warnings.push("stdout truncated");
    if (record.stderrTruncated === true) warnings.push("stderr truncated");
    if (record.timedOut === true || stringField(record, "termination") === "timeout") warnings.push("timed out");
    if (warnings.length > 0) lines.push(style(theme, "warning", `[${warnings.join(" · ")}]`));
    const exit = numberField(record, "exitCode");
    const signal = numberField(record, "termSignal");
    const duration = numberField(record, "durationMs");
    const status = exit !== undefined ? `exit ${exit}` : signal !== undefined ? `signal ${signal}` : stringField(record, "termination");
    const summary = [status, duration === undefined ? undefined : `Took ${formatDuration(duration)}`]
        .filter((value): value is string => value !== undefined).join(" · ");
    if (summary.length > 0) lines.push(style(theme, "muted", summary));
    return lines;
}
