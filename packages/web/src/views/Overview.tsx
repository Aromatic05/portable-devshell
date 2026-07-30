import type { WebState } from "../state/WebStore.js";
import { alerts, openTodos, pendingApprovals, recentActivity } from "../selectors/readModel.js";

export function Overview({ state }: { state: WebState }) {
    const currentAlerts = alerts(state);
    return (
        <section>
            <h2>Overview</h2>
            <div className="metrics" aria-label="Operational summary">
                <Metric label="Service" value={state.service?.ok ? "Ready" : "Unavailable"} />
                <Metric label="Instances" value={`${state.instances.length} total · ${currentAlerts.filter((alert) => alert.id.startsWith("instance:")).length} attention`} />
                <Metric label="Pending approvals" value={String(pendingApprovals(state))} />
                <Metric label="Open todos" value={String(openTodos(state))} />
            </div>
            <div className="overview-grid">
                <section>
                    <h3>Alerts</h3>
                    {currentAlerts.length === 0 ? <p className="empty">No current alerts.</p> : <ul className="alerts">{currentAlerts.slice(0, 8).map((alert) => <li className={alert.severity} key={alert.id}>{alert.message}</li>)}</ul>}
                </section>
                <section>
                    <h3>Recent activity</h3>
                    <ActivityList events={recentActivity(state).slice(0, 6)} empty="No recent activity." />
                </section>
            </div>
        </section>
    );
}

export function ActivityList({ events, empty }: { events: ReturnType<typeof recentActivity>; empty: string }) {
    return events.length === 0 ? <p className="empty">{empty}</p> : <ol className="feed">{events.map((event) => <li key={`${event.instanceName}-${event.seq}`}><time>{event.at}</time><strong>{event.instanceName}</strong> {event.type}</li>)}</ol>;
}

function Metric({ label, value }: { label: string; value: string }) {
    return <div className="card"><span>{label}</span><strong>{value}</strong></div>;
}
