import type { WebState } from "../state/WebStore.js";
import type { InstanceEvent } from "@portable-devshell/shared/browser";
import { overviewActivity, overviewAlerts } from "../selectors/readModel.js";

export function Overview({ state }: { state: WebState }) {
    if (state.overview === undefined) {
        return <section><h2>Overview</h2><p className="empty">{state.connection === "offline" ? "Overview is unavailable while offline." : "Loading operational overview…"}</p></section>;
    }
    const overview = state.overview;
    const currentAlerts = overviewAlerts(overview);
    return (
        <section>
            <h2>Overview</h2>
            <div className="metrics" aria-label="Operational summary">
                <Metric label="Health" value={overview.health} />
                <Metric label="Instances" value={`${overview.counts.instancesTotal} total · ${overview.counts.instancesAttention} attention · ${overview.counts.instancesCritical} critical`} />
                <Metric label="Pending approvals" value={String(overview.counts.pendingApprovals)} />
                <Metric label="Open todos" value={String(overview.counts.activeTodos)} />
            </div>
            <div className="overview-grid">
                <section>
                    <h3><a href="#/approvals">Alerts</a></h3>
                    {currentAlerts.length === 0 ? <p className="empty">No current alerts.</p> : <ul className="alerts">{currentAlerts.map((alert) => <li className={alert.severity} key={alert.id}><a href={alertRoute(alert.kind)}><strong>{alert.title}</strong><br />{alert.detail}</a></li>)}</ul>}
                </section>
                <section>
                    <h3><a href="#/activity">Recent activity</a></h3>
                    {overviewActivity(overview).length === 0 ? <p className="empty">No recent activity.</p> : <ol className="feed">{overviewActivity(overview).map((activity) => <li key={activity.callId}><time>{activity.completedAt ?? activity.startedAt}</time><strong>{activity.instance}</strong> {activity.toolName} · {activity.status}</li>)}</ol>}
                </section>
            </div>
            <div className="overview-grid">
                <section>
                    <h3><a href="#/instances">Instances</a></h3>
                    {overview.instances.length === 0 ? <p className="empty">No instances in the operational overview.</p> : <ul className="summary-list">{overview.instances.slice(0, 6).map((instance) => <li key={instance.name}><strong>{instance.name}</strong> {instance.snapshot.status} · {instance.snapshot.connectionState} · {instance.pendingApprovals} pending approvals</li>)}</ul>}
                </section>
                <section>
                    <h3><a href="#/todos">Todo summary</a></h3>
                    {overview.todos.length === 0 ? <p className="empty">No active todos.</p> : <ul className="summary-list">{overview.todos.slice(0, 6).map((todo) => <li key={`${todo.instance}-${todo.taskId}`}><strong>{todo.title}</strong> {todo.instance} · {todo.completed}/{todo.total} complete · {todo.status}</li>)}</ul>}
                </section>
            </div>
        </section>
    );
}

function alertRoute(kind: string): string {
    if (kind.startsWith("approval.")) return "#/approvals";
    if (kind.startsWith("todo.")) return "#/todos";
    if (kind.startsWith("activity.")) return "#/activity";
    return "#/instances";
}

export function ActivityList({ events, empty }: { events: InstanceEvent[]; empty: string }) {
    return events.length === 0 ? <p className="empty">{empty}</p> : <ol className="feed">{events.map((event) => <li key={`${event.instanceName}-${event.seq}`}><time>{event.at}</time><strong>{event.instanceName}</strong> {event.type}</li>)}</ol>;
}

function Metric({ label, value }: { label: string; value: string }) {
    return <div className="card"><span>{label}</span><strong>{value}</strong></div>;
}
