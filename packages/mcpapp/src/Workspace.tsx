import { useEffect, useRef, useState, type ReactNode } from "react";
import { readMcpAppActivityImage, readMcpAppActivityOutput, type McpAppActivityImage, type McpAppItem, type McpAppSnapshot } from "./Connection.js";
import type { McpAppSession } from "./Session.js";
import { ToolCallCard } from "./ToolCall.js";
import { record } from "./ToolCallModel.js";

type Tab = "overview" | "tasks" | "activity";
type Activity = NonNullable<McpAppSnapshot["activity"]>[number];

function taskTranscript(item: Activity, reads: readonly Activity[]): unknown {
    const base = record(item.output) ?? {};
    if (item.name !== "tmux_run" || reads.length === 0) return item.output;
    // Audit is immutable. Build the current terminal from the available
    // recorded output fragments, not from another long-running HTTP watcher.
    const ordered = [item, ...reads].sort((a, b) => a.at.localeCompare(b.at));
    const lines = ordered.flatMap((entry) => {
        const output = record(entry.output)?.output;
        return Array.isArray(output) ? output.filter((part): part is string =>
            typeof part === "string") : [];
    }).slice(-100);
    const latest = record(ordered.at(-1)?.output);
    return { ...base, output: lines, task: record(latest?.task) ?? base.task };
}

/** Context-scoped terminal streams are loaded only when this audit card is opened. */
function ActivityCard({ item, reads, session }: {
    item: Activity; reads: readonly Activity[]; session?: McpAppSession;
}) {
    const [terminal, setTerminal] = useState<{
        stdout: string; stderr: string; nextSeq?: number;
        loaded: boolean; loading: boolean; error?: string;
    }>({ stdout: "", stderr: "", loaded: false, loading: false });
    const [image, setImage] = useState<McpAppActivityImage>();
    const [imageLoading, setImageLoading] = useState(false);
    const [imageError, setImageError] = useState<string>();
    const controller = useRef<AbortController>();
    const imageController = useRef<AbortController>();
    useEffect(() => () => {
        controller.current?.abort();
        imageController.current?.abort();
    }, [session, item.callId]);
    const load = (fromSeq: number) => {
        if (!session || terminal.loading) return;
        controller.current?.abort();
        const pending = new AbortController();
        controller.current = pending;
        setTerminal((previous) => ({ ...previous, loading: true, error: undefined }));
        void readMcpAppActivityOutput(session, item.callId, fromSeq, pending.signal).then((page) => {
            if (pending.signal.aborted) return;
            setTerminal((previous) => ({
                stdout: previous.stdout + page.stdout,
                stderr: previous.stderr + page.stderr,
                loaded: true,
                loading: false,
                nextSeq: page.nextSeq,
            }));
        }).catch((error: unknown) => {
            if (pending.signal.aborted) return;
            setTerminal((previous) => ({
                ...previous, loading: false,
                error: error instanceof Error ? error.message : "Unable to read retained output",
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
            setImageError(error instanceof Error ? error.message : "Unable to load image preview");
            setImageLoading(false);
        });
    };
    const failed = item.state === "failed" || item.state === "denied";
    const summary = [item.summary ?? (item.exitCode === undefined
        ? undefined : "exit " + item.exitCode), item.name === "tmux_run" && reads.length
        ? reads.length + " transcript reads" : undefined].filter(Boolean).join(" · ");
    const output = isShell && session ? {
        ...record(item.output),
        activityRetained: true,
        ...(terminal.loaded ? { stdout: terminal.stdout, stderr: terminal.stderr } : {}),
        ...(terminal.loading ? { activityStatus: "loading" } : {}),
        ...(terminal.error ? { activityError: terminal.error } : {}),
    } : isImage && session ? {
        ...record(item.output),
        ...(imageLoading ? { activityImageStatus: "loading" } : {}),
        ...(imageError ? { activityImageError: imageError } : {}),
    } : taskTranscript(item, reads);
    return <ToolCallCard name={item.name}
        input={item.input ?? (isShell || item.name === "tmux_run"
            ? { command: item.target } : { path: item.target })}
        purpose={item.purpose} summary={summary}
        detail={item.detail} state={item.state}
        result={{ name: item.name, isError: failed, output,
            ...(image ? { image } : {}) }}
        onExpandedChange={(open) => {
            if (open && isShell && session && !terminal.loading && !terminal.loaded) load(1);
            if (open && isImage && session && !imageLoading && !image) loadImage();
        }}
        expandedFooter={isImage && session && imageError
            ? <div className="tc-activity-actions">
                <button type="button" disabled={imageLoading} onClick={loadImage}>
                    {imageLoading ? "Loading…" : "Retry image"}
                </button>
            </div> : isShell && session && (terminal.nextSeq !== undefined || terminal.error)
            ? <div className="tc-activity-actions">
                <button type="button" disabled={terminal.loading}
                    onClick={() => load(terminal.nextSeq ?? 1)}>
                    {terminal.loading ? "Loading…" : terminal.error ? "Retry output" : "Load more output"}
                </button>
            </div> : undefined} />;
}

export function WorkspaceDashboard({ snapshot, renderItem, session }: {
    snapshot: McpAppSnapshot;
    renderItem: (item: McpAppItem, kind: string) => ReactNode;
    session?: McpAppSession;
}) {
    const [tab, setTab] = useState<Tab>("overview");
    const [fallback, setFallback] = useState(false);
    const [showHistory, setShowHistory] = useState(true);
    const [showInternalCalls, setShowInternalCalls] = useState(false);
    const { primary, work, background } = snapshot.presentation;
    const isQuestion = primary?.title === "Question for you";
    const pendingCount = primary ? 1 : 0;
    const shownPlans = new Set<string>();
    const visibleActivity = showInternalCalls ? snapshot.activity : snapshot.activity?.filter((item) => {
        if (item.name === "tmux_read" || item.name === "mcpapp_open") return false;
        if ((item.name === "todo_write" || item.name === "todo_read") && item.taskId) {
            if (shownPlans.has(item.taskId)) return false;
            shownPlans.add(item.taskId);
        }
        return true;
    });
    const pollsByTask = new Map<string, Activity[]>();
    for (const item of snapshot.activity ?? []) {
        if (item.name !== "tmux_read" || !item.taskId) continue;
        pollsByTask.set(item.taskId, [...(pollsByTask.get(item.taskId) ?? []), item]);
    }
    return <div className="dashboard">
        <div className="dashboard-overview">
            <div className="dashboard-title">
                <h1>{snapshot.agentBusy ? "Execution in progress" : "Workspace ready"}</h1>
                <p>{snapshot.instance} · <span>{snapshot.ctxId}</span></p>
            </div>
            <div className="dashboard-metrics">
                <div><strong>{work.length}</strong><span>Active tasks / goals</span></div>
                <div><strong>{pendingCount}</strong><span>Human decisions</span></div>
                <div><strong>{background.length}</strong><span>Tracked waits</span></div>
            </div>
        </div>
        <nav className="dashboard-tabs" aria-label="Workspace views">
            {(["overview", "tasks", "activity"] as const).map((entry) =>
                <button type="button" key={entry} aria-current={tab === entry ? "page" : undefined}
                    onClick={() => setTab(entry)}>{entry === "overview" ? "Overview" :
                        entry === "tasks" ? "Tasks" : "Activity"}</button>)}
        </nav>
        <section className="dashboard-panel" aria-label={tab === "overview" ?
            "Overview" : tab === "tasks" ? "Tasks" : "Activity"}>
            {tab !== "activity" && <>
                <h2>{tab === "tasks" ? "Current work" : "Work in progress"}</h2>
                {work.length ? <div className="dashboard-items">
                    {work.map((item) => <div key={item.id}>{renderItem(item, "work")}</div>)}
                </div> : <p className="dashboard-empty">No active Task or Goal for this Context.</p>}
            </>}
            {tab === "overview" && <>
                <h2>Needs attention</h2>
                {primary ? <>
                    <p className="dashboard-notice">
                        {primary.title === "Approval required"
                            ? "An approval is pending in the conversation."
                            : isQuestion ? "A question is awaiting an answer in the conversation."
                            : "A decision is pending in the conversation."}
                    </p>
                    {isQuestion && <div className="workspace-fallback">
                        <button type="button" onClick={() => setFallback(!fallback)}>
                            {fallback ? "Hide fallback" : "Answer here if Inline is unavailable"}
                        </button>
                        {fallback && renderItem(primary, "decision")}
                    </div>}
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
                    Include polling, plan revisions and workspace events
                </label>}
                {!showHistory ? <p className="dashboard-empty">ToolCall history is hidden.</p> :
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
                <p className="dashboard-help">Recent Context audit. Task transcripts collect available
                    reads; results do not require the original Inline cards to stay mounted.</p>
            </>}
        </section>
    </div>;
}
