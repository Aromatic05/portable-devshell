import { useState, type ReactNode } from "react";
import type { McpAppItem, McpAppSnapshot } from "./Connection.js";

type Tab = "overview" | "tasks" | "activity";

export function WorkspaceDashboard({ snapshot, renderItem }: {
    snapshot: McpAppSnapshot;
    renderItem: (item: McpAppItem, kind: string) => ReactNode;
}) {
    const [tab, setTab] = useState<Tab>("overview");
    const [fallback, setFallback] = useState(false);
    const [showHistory, setShowHistory] = useState(true);
    const { primary, work, background } = snapshot.presentation;
    const isQuestion = primary?.title === "Question for you";
    const pendingCount = primary ? 1 : 0;
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
                    onClick={() => setTab(entry)}>{entry === "overview" ? "Overview" : entry === "tasks" ? "Tasks" : "Activity"}</button>)}
        </nav>
        <section className="dashboard-panel" aria-label={tab === "overview" ? "Overview" : tab === "tasks" ? "Tasks" : "Activity"}>
            {tab !== "activity" && <>
                <h2>{tab === "tasks" ? "Current work" : "Work in progress"}</h2>
                {work.length ? <div className="dashboard-items">
                    {work.map((item) => <div key={item.id}>{renderItem(item, "work")}</div>)}
                </div> : <p className="dashboard-empty">No active Task or Goal for this Context.</p>}
            </>}
            {tab !== "tasks" && <>
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
                {!showHistory ? <p className="dashboard-empty">ToolCall history is hidden.</p> : snapshot.activity?.length ? <ol className="dashboard-timeline">
                    {snapshot.activity.map((item) =>
                        <li key={item.callId} data-state={item.state}>
                            <div className="activity-card-head">
                                <span className="activity-dot" aria-hidden="true" />
                                <div className="activity-entry">
                                    <strong>{item.name}</strong>
                                    <span>{item.state}{item.exitCode === undefined ? "" : ` · exit ${item.exitCode}`}</span>
                                </div>
                                <time dateTime={item.at}>{Number.isNaN(Date.parse(item.at))
                                    ? item.at : new Date(item.at).toLocaleTimeString()}</time>
                            </div>
                            {item.purpose && <p className="activity-purpose">{item.purpose}</p>}
                            {item.target && <code className="activity-target">{item.target}</code>}
                            {item.summary && <p className="activity-summary">{item.summary}</p>}
                            {item.detail && <details className="toolcall-details">
                                <summary>View result</summary>
                                <pre>{item.detail}</pre>
                            </details>}
                        </li>)}
                </ol> : <p className="dashboard-empty">No recent audited ToolCalls for this Context.</p>}
                <p className="dashboard-help">History is read from this Context's Instance audit. Inline cards are not required to remain mounted.</p>
            </>}
        </section>
    </div>;
}
