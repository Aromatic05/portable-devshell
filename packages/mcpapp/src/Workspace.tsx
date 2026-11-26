import { useEffect, useRef, useState, type ReactNode } from "react";
import { mcpAppReadErrorMessage, readMcpAppActivityImage, readMcpAppActivityOutput, readMcpAppTimeline, type McpAppActivity, type McpAppActivityImage, type McpAppItem, type McpAppSnapshot } from "./Connection.js";
import type { McpAppSession } from "./Session.js";
import { ToolCallCard } from "./ToolCall.js";
import { record } from "./ToolCallModel.js";

type Tab = "overview" | "activity";
type Activity = McpAppActivity;
const emptyTerminal = { stdout: "", stderr: "", loaded: false, loading: false };
const internalActivity = new Set([
    "environ_info", "progress_report", "workspace_goal",
    "task_input", "task_inspect", "task_manage",
]);

function taskTranscript(
    item: Activity,
    reads: readonly Activity[],
    retained?: { stdout: string; stderr: string },
): unknown {
    const base = record(item.output) ?? {};
    if (item.name !== "bash_run" || reads.length === 0)
        return retained === undefined ? item.output : { ...base, ...retained };
    const ordered = [...reads].sort((a, b) => a.at.localeCompare(b.at));
    const latest = record(ordered.at(-1)?.output);
    const stream = (key: "stdout" | "stderr") => {
        let text = retained?.[key] ?? (typeof base[key] === "string" ? base[key] : "");
        let prevCursor = typeof base.cursor === "string" ? base.cursor : undefined;
        for (const entry of ordered) {
            const result = record(entry.output);
            const fragment = result?.[key];
            const start = record(entry.input)?.cursor;
            const next = result?.cursor;
            if (typeof fragment !== "string" || fragment === "") {
                if (typeof next === "string") prevCursor = next;
                continue;
            }
            if (typeof start === "string") {
                if (typeof next === "string" && next === prevCursor) continue;
                if (prevCursor !== undefined && start === prevCursor) {
                    text += fragment;
                } else if (prevCursor === undefined && text === "") {
                    text = fragment;
                } else {
                    text += "\n[Overlapping task output observation]\n" + fragment;
                }
                if (typeof next === "string") prevCursor = next;
            } else {
                if (text.length > 0 && fragment.startsWith(text)) {
                    text = fragment;
                } else if (text.length === 0 || !text.endsWith(fragment)) {
                    text += fragment;
                }
                if (typeof next === "string") prevCursor = next;
            }
        }
        return retained === undefined ? text.slice(-12_000) : text;
    };
    return { ...base, ...latest, stdout: stream("stdout"), stderr: stream("stderr"), task: record(latest?.task) ?? base.task };
}

/** Context-scoped terminal streams are loaded only when this audit card is opened. */
function ActivityCard({ item, reads, session }: {
    item: Activity; reads: readonly Activity[]; session?: McpAppSession;
}) {
    const [terminal, setTerminal] = useState<{
        stdout: string; stderr: string; nextSeq?: number; nextOffset?: number;
        loaded: boolean; loading: boolean; error?: string;
    }>(emptyTerminal);
    const [image, setImage] = useState<McpAppActivityImage>();
    const [imageLoading, setImageLoading] = useState(false);
    const [imageError, setImageError] = useState<string>();
    const controller = useRef<AbortController>();
    const imageController = useRef<AbortController>();
    useEffect(() => () => {
        controller.current?.abort();
        imageController.current?.abort();
    }, [session, item.callId]);
    const load = (fromSeq: number, offset = 0) => {
        if (!session || terminal.loading) return;
        controller.current?.abort();
        const pending = new AbortController();
        controller.current = pending;
        setTerminal((previous) => ({ ...previous, loading: true, error: undefined }));
        void readMcpAppActivityOutput(session, item.callId, fromSeq, pending.signal, offset).then((page) => {
            if (pending.signal.aborted) return;
            setTerminal((previous) => ({
                stdout: previous.stdout + page.stdout,
                stderr: previous.stderr + page.stderr,
                loaded: true,
                loading: false,
                nextSeq: page.nextSeq,
                nextOffset: page.nextOffset,
            }));
        }).catch((error: unknown) => {
            if (pending.signal.aborted) return;
            setTerminal((previous) => ({
                ...previous, loading: false,
                error: mcpAppReadErrorMessage(error, "Retained output"),
            }));
        });
    };
    const isShell = item.name === "bash_run";
    const isImage = item.name === "artifact_viewImage";
    const loadImage = () => {
        if (!session || imageLoading || image) return;
        imageController.current?.abort();
        const pending = new AbortController();
        imageController.current = pending;
        setImageError(undefined);
        setImageLoading(true);
        void readMcpAppActivityImage(session, item.callId, pending.signal).then((next) => {
            if (pending.signal.aborted) return;
            setImage(next);
            setImageLoading(false);
        }).catch((error: unknown) => {
            if (pending.signal.aborted) return;
            setImageError(mcpAppReadErrorMessage(error, "Image preview"));
            setImageLoading(false);
        });
    };
    const failed = item.state === "failed" || item.state === "denied";
    const summary = [item.summary ?? (item.exitCode === undefined
        ? undefined : "exit " + item.exitCode), item.name === "bash_run" && reads.length
        ? reads.length + " transcript reads" : undefined].filter(Boolean).join(" · ");
    const output = isShell && session ? {
        ...record(taskTranscript(item, reads, terminal.loaded ? { stdout: terminal.stdout, stderr: terminal.stderr } : undefined)),
        activityRetained: true,
        ...(terminal.loading ? { activityStatus: "loading" } : {}),
        ...(terminal.error ? { activityError: terminal.error } : {}),
    } : isImage && session ? {
        ...record(item.output),
        ...(imageLoading ? { activityImageStatus: "loading" } : {}),
        ...(imageError ? { activityImageError: imageError } : {}),
    } : taskTranscript(item, reads);
    return <ToolCallCard name={item.name}
        input={item.input ?? (isShell || item.name === "bash_run"
            ? { command: item.target } : { path: item.target })}
        purpose={item.purpose} summary={summary}
        detail={item.detail} state={item.state}
        result={{ name: item.name, isError: failed, output,
            ...(image ? { image } : {}) }}
        onExpandedChange={(open) => {
            if (open && isShell && session && !terminal.loading && !terminal.loaded) load(1);
            if (open && isImage && session && !imageLoading && !image) loadImage();
            if (!open && isShell) {
                controller.current?.abort();
                setTerminal(emptyTerminal);
            }
            if (!open && isImage) {
                imageController.current?.abort();
                setImage(undefined);
                setImageLoading(false);
            }
        }}
        expandedFooter={isImage && session && imageError
            ? <div className="tc-activity-actions">
                <button type="button" disabled={imageLoading} onClick={loadImage}>
                    {imageLoading ? "Loading…" : "Retry image"}
                </button>
            </div> : isShell && session && (terminal.nextSeq !== undefined || terminal.error)
            ? <div className="tc-activity-actions">
                <button type="button" disabled={terminal.loading}
                    onClick={() => load(terminal.nextSeq ?? 1, terminal.nextOffset)}>
                    {terminal.loading ? "Loading…" : terminal.error ? "Retry output" : "Load more output"}
                </button>
            </div> : undefined} />;
}

export function WorkspaceDashboard({ snapshot, renderItem, session, fresh = true }: {
    snapshot: McpAppSnapshot;
    fresh?: boolean;
    renderItem: (item: McpAppItem, kind: string) => ReactNode;
    session?: McpAppSession;
}) {
    const [tab, setTab] = useState<Tab>("overview");
    const [showHistory, setShowHistory] = useState(true);
    const [showInternalCalls, setShowInternalCalls] = useState(false);
    const [activity, setActivity] = useState<Activity[]>();
    const [activityError, setActivityError] = useState<string>();
    const { primary, work, background } = snapshot.presentation;
    const pendingCount = snapshot.presentation.pendingApprovals ?? (primary ? 1 : 0);
    useEffect(() => {
        if (tab !== "activity" || !showHistory || session === undefined) return;
        const controller = new AbortController();
        setActivityError(undefined);
        void readMcpAppTimeline(session, controller.signal).then((next) => {
            if (!controller.signal.aborted) setActivity(next);
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) setActivityError(
                mcpAppReadErrorMessage(error, "Activity history"),
            );
        });
        return () => controller.abort();
    }, [tab, showHistory, snapshot.cursor, session]);
    const history = session ? activity : snapshot.activity;
    const visibleActivity = showInternalCalls ? history : history?.filter((item) => {
        if (internalActivity.has(item.name) || item.name.startsWith("mcpapp_")) return false;
        return true;
    });
    const pollsByTask = new Map<string, Activity[]>();
    for (const item of history ?? []) {
        if (item.name !== "task_input" || !item.taskId) continue;
        pollsByTask.set(item.taskId, [...(pollsByTask.get(item.taskId) ?? []), item]);
    }
    return <div className="dashboard">
        <div className="dashboard-overview">
            <div className="dashboard-title">
                <h1>{!fresh ? "Reconnecting to workspace" : snapshot.agentBusy ? "Execution in progress" : "Workspace ready"}</h1>
                <p>{snapshot.instance} · <span>{snapshot.ctxId}</span></p>
            </div>
            <div className="dashboard-metrics">
                <div><strong>{work.length}</strong><span>Active Goals</span></div>
                <div><strong>{pendingCount}</strong><span>Pending approvals</span></div>
                <div><strong>{background.length}</strong><span>Tracked waits</span></div>
            </div>
        </div>
        <nav className="dashboard-tabs" aria-label="Workspace views">
            {(["overview", "activity"] as const).map((entry) =>
                <button type="button" key={entry} aria-current={tab === entry ? "page" : undefined}
                    onClick={() => setTab(entry)}>{entry === "overview" ? "Overview" : "Activity"}</button>)}
        </nav>
        <section className="dashboard-panel" aria-label={tab === "overview" ? "Overview" : "Activity"}>
            {tab === "overview" && <>
                <h2>Current Goal</h2>
                {work.length ? <div className="dashboard-items">
                    {work.map((item) => <div key={item.id}>{renderItem(item, "work")}</div>)}
                </div> : <p className="dashboard-empty">No active Goal for this Context.</p>}
            </>}
            {tab === "overview" && <>
                <h2>Needs attention</h2>
                {primary ? <>
                    <p className="dashboard-notice">
                        {primary.title === "Approval required"
                            ? pendingCount > 1
                                ? `Approval 1 of ${pendingCount} is awaiting your decision.`
                                : "An approval is awaiting your decision."
                            : "A decision is awaiting your input."}
                    </p>
                    {renderItem(primary, "decision")}
                </> : <p className="dashboard-empty">No pending human decision.</p>}
                <h2>Background waits</h2>
                {background.length ? <div className="dashboard-items">
                    {background.map((item) => <div key={item.id}>{renderItem(item, "background")}</div>)}
                </div> : <p className="dashboard-empty">No active tracked wait.</p>}
            </>}
            {tab === "activity" && <>
                <div className="dashboard-activity-head">
                    <h2>Recent ToolCalls</h2>
                    <label className="workspace-setting">
                        <input type="checkbox" checked={showHistory}
                            onChange={(event) => setShowHistory(event.target.checked)} />
                        Show history
                    </label>
                </div>
                {showHistory && <label className="workspace-setting">
                    <input type="checkbox" checked={showInternalCalls}
                        onChange={(event) => setShowInternalCalls(event.target.checked)} />
                    Include polling and workspace events
                </label>}
                {!showHistory ? <p className="dashboard-empty">ToolCall history is hidden.</p> :
                    activityError ? <p role="alert">{activityError}</p> :
                    visibleActivity === undefined ? <p className="dashboard-empty">Loading ToolCall history…</p> :
                    visibleActivity?.length ? <ol className="dashboard-timeline">
                        {visibleActivity.map((item) => {
                            const reads = item.taskId ? pollsByTask.get(item.taskId) ?? [] : [];
                            return <li key={snapshot.ctxId + ":" + item.callId} data-state={item.state}>
                                <time className="tc-activity-time" dateTime={item.at}>
                                    {Number.isNaN(Date.parse(item.at)) ? item.at :
                                        new Date(item.at).toLocaleTimeString()}</time>
                                <ActivityCard item={item} reads={reads} session={session} />
                            </li>;
                        })}
                    </ol> : <p className="dashboard-empty">No recent audited ToolCalls for this Context.</p>}
            </>}
        </section>
    </div>;
}
