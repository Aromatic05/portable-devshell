import { useState } from "react";
import type {
    InstanceLogEntry,
    ToolCallRecord,
} from "@portable-devshell/shared/browser";

import {
    formatRelativeTime,
    formatToolValue,
    resolveToolCallOutput,
    toolCallDuration,
} from "../../formatters/toolCalls.js";
import { toolCallResult } from "../../selectors/toolCalls.js";

export function ToolCallEntry({
    call,
    disabled = false,
    logs,
    onRefresh,
}: {
    call: ToolCallRecord;
    disabled?: boolean;
    logs: readonly InstanceLogEntry[];
    onRefresh(): Promise<void>;
}) {
    const [open, setOpen] = useState(false);
    return <li className="activity-record tool-call-record">
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary><time dateTime={call.startedAt} title={call.startedAt}>{formatRelativeTime(call.startedAt)}</time><strong>{call.toolName}</strong><span>{call.instance} · {call.source} · {call.ctxId ?? "unscoped"}</span><span className={`result ${toolCallResult(call)}`}>{call.status}</span></summary>
            {open ? <ToolCallDetails call={call} disabled={disabled} logs={logs} onRefresh={onRefresh} /> : null}
        </details>
    </li>;
}

function ToolCallDetails({
    call,
    disabled,
    logs,
    onRefresh,
}: {
    call: ToolCallRecord;
    disabled: boolean;
    logs: readonly InstanceLogEntry[];
    onRefresh(): Promise<void>;
}) {
    const output = resolveToolCallOutput(call, logs);
    const [refreshing, setRefreshing] = useState(false);
    const refresh = async (): Promise<void> => {
        setRefreshing(true);
        try {
            await onRefresh();
        } finally {
            setRefreshing(false);
        }
    };
    return <>
        <button disabled={disabled || refreshing} onClick={() => void refresh()} type="button">
            {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <dl className="activity-detail">
            <div><dt>Call</dt><dd>{call.callId}</dd></div>
            <div><dt>Context</dt><dd>{call.ctxId ?? "unscoped"}</dd></div>
            <div><dt>Workspace</dt><dd>{call.workspace ?? "-"}</dd></div>
            <div><dt>Started</dt><dd>{call.startedAt}</dd></div>
            <div><dt>Completed</dt><dd>{call.completedAt ?? "-"}</dd></div>
            <div><dt>Duration</dt><dd>{toolCallDuration(call)}</dd></div>
            <div><dt>Request</dt><dd>{call.requestId ?? "-"}</dd></div>
            <div><dt>Termination</dt><dd>{call.termination ?? "-"}</dd></div>
            <div><dt>Exit code</dt><dd>{call.exitCode ?? "-"}</dd></div>
        </dl>
        <h3>Input</h3><pre>{formatToolValue(call.input, call.inputSummary)}</pre>
        <h3>Output</h3><pre>{formatToolValue(output)}</pre>
        {call.error === undefined ? null : <><h3>Error</h3><pre className="error">{call.error}</pre></>}
    </>;
}
