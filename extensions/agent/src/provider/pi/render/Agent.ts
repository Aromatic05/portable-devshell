import type { JsonValue } from "@portable-devshell/shared";

import type { PiThemeLike } from "./Types.js";
import { asRecord, stringField, style } from "./Utils.js";

const COLLAPSED_AGENTS = 6;

export function formatAgentCall(
    toolName: string,
    record: Record<string, unknown>,
    theme?: PiThemeLike,
): string {
    switch (toolName) {
        case "agent_spawn": {
            const name = stringField(record, "name") ?? "child";
            const profile = stringField(record, "profile");
            const task = preview(stringField(record, "task") ?? "");
            return [
                style(theme, "toolTitle", "agent spawn", true),
                style(theme, "accent", name),
                ...(profile === undefined
                    ? []
                    : [style(theme, "muted", `[${profile}]`)]),
                ...(task.length === 0
                    ? []
                    : [`\n  ${style(theme, "dim", task)}`]),
            ].join(" ");
        }
        case "agent_poll":
            return style(theme, "toolTitle", "agent poll", true);
        case "agent_interact": {
            const agent = stringField(record, "agent") ?? "agent";
            const interrupt = record.interrupt === true ? " interrupt" : "";
            return `${style(theme, "toolTitle", "agent interact", true)} ${style(theme, "accent", agent)}${style(theme, "muted", interrupt)}`;
        }
        case "agent_manage":
            return `${style(theme, "toolTitle", "agent manage", true)} ${style(theme, "accent", stringField(record, "agent") ?? "agent")} ${style(theme, "muted", stringField(record, "action") ?? "")}`;
        default:
            return style(theme, "toolTitle", toolName, true);
    }
}

export function renderAgentResult(
    toolName: string,
    details: JsonValue | undefined,
    expanded: boolean,
    theme?: PiThemeLike,
): string[] {
    const record = asRecord(details);
    if (record === undefined) return [];
    if (toolName === "agent_poll") return renderPoll(record, expanded, theme);
    return renderSnapshot(record, expanded, theme);
}

function renderPoll(
    record: Record<string, unknown>,
    expanded: boolean,
    theme?: PiThemeLike,
): string[] {
    const agents = Array.isArray(record.agents) ? record.agents : [];
    const shown = expanded ? agents : agents.slice(0, COLLAPSED_AGENTS);
    const lines = shown.flatMap((value) => {
        const agent = asRecord(value);
        return agent === undefined ? [] : [renderAgentLine(agent, theme)];
    });
    if (!expanded && agents.length > shown.length)
        lines.push(style(theme, "muted", `... ${agents.length - shown.length} more agents (Ctrl+O to expand)`));
    const events = Array.isArray(record.events) ? record.events : [];
    if (expanded && events.length > 0) {
        lines.push(style(theme, "muted", "events:"));
        for (const value of events) {
            const event = asRecord(value);
            if (event === undefined) continue;
            const detail = stringField(event, "detail");
            lines.push(
                `  ${style(theme, "accent", stringField(event, "agent") ?? "agent")} ${style(theme, "muted", stringField(event, "type") ?? "event")}${detail === undefined ? "" : ` ${style(theme, "toolOutput", preview(detail))}`}`,
            );
        }
    }
    if (record.timedOut === true)
        lines.push(style(theme, "muted", "poll timed out"));
    return lines;
}

function renderSnapshot(
    record: Record<string, unknown>,
    expanded: boolean,
    theme?: PiThemeLike,
): string[] {
    const lines = [renderAgentLine(record, theme)];
    if (expanded) {
        const task = stringField(record, "task");
        if (task !== undefined) lines.push(style(theme, "dim", `Task: ${task}`));
        const turn = asRecord(record.lastTurn);
        const result = turn === undefined ? undefined : stringField(turn, "result");
        const error = turn === undefined ? undefined : stringField(turn, "error");
        if (result !== undefined) lines.push(style(theme, "toolOutput", result));
        if (error !== undefined) lines.push(style(theme, "error", error));
    }
    return lines;
}

function renderAgentLine(
    record: Record<string, unknown>,
    theme?: PiThemeLike,
): string {
    const lifecycle = stringField(record, "lifecycle");
    const activity = stringField(record, "activity");
    const lastTurn = asRecord(record.lastTurn);
    const outcome = lastTurn === undefined ? undefined : stringField(lastTurn, "outcome");
    const icon =
        lifecycle === "terminated"
            ? "○"
            : activity === "running"
              ? "●"
              : outcome === "failed"
                ? "✗"
                : "✓";
    const agent = stringField(record, "agent") ?? "agent";
    const profile = stringField(record, "profile");
    const activityText = stringField(record, "lastActivity") ?? activity ?? "idle";
    return `${style(theme, activity === "running" ? "warning" : "success", icon)} ${style(theme, "accent", agent)}${profile === undefined ? "" : ` ${style(theme, "muted", `[${profile}]`)}`} ${style(theme, "dim", activityText)}`;
}

function preview(value: string): string {
    const oneLine = value.replace(/\s+/gu, " ").trim();
    return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}
