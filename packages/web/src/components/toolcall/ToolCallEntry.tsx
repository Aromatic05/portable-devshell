import { useEffect, useState } from "react";
import type {
    InstanceLogEntry,
    ToolCallRecord,
} from "@portable-devshell/shared/browser";
import { workspaceFolderName } from "@portable-devshell/shared/browser";

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
    initiallyOpen = false,
    logs,
    onLoadDetail,
    onRefresh,
}: {
    call: ToolCallRecord;
    disabled?: boolean;
    initiallyOpen?: boolean;
    logs: readonly InstanceLogEntry[];
    onLoadDetail(): Promise<ToolCallRecord | undefined>;
    onRefresh(): Promise<void>;
}) {
    const [open, setOpen] = useState(initiallyOpen);
    const [detail, setDetail] = useState<ToolCallRecord | undefined>();
    const [loading, setLoading] = useState(false);
    const [loadFailure, setLoadFailure] = useState<string>();
    useEffect(() => {
        if (initiallyOpen) setOpen(true);
    }, [initiallyOpen]);
    const load = async (): Promise<void> => {
        if (detail !== undefined || loading || call.input !== undefined || call.output !== undefined) return;
        setLoading(true);
        setLoadFailure(undefined);
        try {
            setDetail(await onLoadDetail());
        } catch (error) {
            setLoadFailure(errorMessage(error, "Tool Call detail could not be loaded."));
        } finally {
            setLoading(false);
        }
    };
    const visibleCall = call.input !== undefined || call.output !== undefined ? call : (detail ?? call);
    return <li className="activity-record tool-call-record">
        <details open={open}>
            <summary onClick={(event) => {
                event.preventDefault();
                const next = !open;
                setOpen(next);
                if (next) void load();
            }}><time dateTime={call.startedAt} title={call.startedAt}>{formatRelativeTime(call.startedAt)}</time><strong>{call.toolName}</strong><span>{workspaceFolderName(call.workspace)} · {call.instance}</span><span>ctx {call.ctxId ?? "unscoped"}</span><span className={`result ${toolCallResult(call)}`}>{call.status}</span></summary>
            {open && loading ? <p>Loading details…</p> : null}
            {open && loadFailure !== undefined ? <p className="error" role="alert">{loadFailure}</p> : null}
            {open && !loading ? <ToolCallDetails call={visibleCall} disabled={disabled} logs={logs} onRefresh={onRefresh} /> : null}
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
    const [refreshFailure, setRefreshFailure] = useState<string>();
    const refresh = async (): Promise<void> => {
        setRefreshing(true);
        setRefreshFailure(undefined);
        try {
            await onRefresh();
        } catch (error) {
            setRefreshFailure(errorMessage(error, "Tool Call could not be refreshed."));
        } finally {
            setRefreshing(false);
        }
    };
    return <>
        <button disabled={disabled || refreshing} onClick={() => void refresh()} type="button">
            {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {refreshFailure === undefined ? null : <p className="error" role="alert">{refreshFailure}</p>}
        <dl className="activity-detail">
            <div><dt>Call</dt><dd>{call.callId}</dd></div>
            <div><dt>Context</dt><dd>{call.ctxId ?? "unscoped"}</dd></div>
            <div><dt>Workspace</dt><dd>{call.workspace ?? "-"}</dd></div>
            <div><dt>Started</dt><dd>{call.startedAt}</dd></div>
            <div><dt>Completed</dt><dd>{call.completedAt ?? "-"}</dd></div>
            <div><dt>Duration</dt><dd>{toolCallDuration(call)}</dd></div>
            <div><dt>Request</dt><dd>{call.requestId ?? "-"}</dd></div>
            {call.purpose === undefined ? null : <div><dt>Purpose</dt><dd>{call.purpose}</dd></div>}
            {call.explanation === undefined ? null : <div><dt>Explanation</dt><dd>{call.explanation}</dd></div>}
            <div><dt>Termination</dt><dd>{call.termination ?? "-"}</dd></div>
            <div><dt>Exit code</dt><dd>{call.exitCode ?? "-"}</dd></div>
        </dl>
        <h3>Input</h3><pre>{formatToolValue(call.input, call.inputSummary)}</pre>
        <h3>Output</h3><pre>{formatToolValue(output)}</pre>
        {call.error === undefined ? null : <><h3>Error</h3><pre className="error">{call.error}</pre></>}
    </>;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
