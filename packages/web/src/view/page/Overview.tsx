import {
    formatBytes,
    formatDuration,
    formatPercent,
    type OperationalOverviewSystem,
} from "@portable-devshell/shared/browser";

import type { WebState } from "../../state/Store.js";
import { webFailures } from "../../state/Model.js";
import { webRouteHref } from "../../app/Route.js";
import {
    overviewAlertRoute,
    overviewAlerts,
    overviewToolCalls,
} from "../ReadModel.js";

export function Overview({ state }: { state: WebState }) {
    const overview = state.readModel.overview;
    if (overview === undefined) {
        const failure = webFailures(state.readModel).overview;
        const message =
            state.connection === "offline"
                ? "Overview is unavailable while offline."
                : failure === undefined
                  ? "Loading operational overview…"
                  : `Overview could not be refreshed: ${failure}`;
        return (
            <section>
                <h2>Overview</h2>
                <p className={failure === undefined ? "empty" : "error"}>
                    {message}
                </p>
            </section>
        );
    }
    const currentAlerts = overviewAlerts(overview);
    return (
        <section>
            <h2>Overview</h2>
            <div className="metrics" aria-label="Operational summary">
                <Metric label="Health" value={overview.health} />
                <Metric
                    label="Instances"
                    value={`${overview.counts.instancesTotal} total · ${overview.counts.instancesAttention} attention · ${overview.counts.instancesCritical} critical`}
                />
                <Metric
                    label="Pending approvals"
                    value={String(overview.counts.pendingApprovals)}
                />
                <Metric
                    label="Open todos"
                    value={String(overview.counts.activeTodos)}
                />
            </div>
            <SystemResources
                system={overview.controller.system}
                uptimeSeconds={overview.controller.uptimeSeconds}
            />
            <div className="overview-grid">
                <section>
                    <h3>
                        <a href="#/overview">Alerts</a>
                    </h3>
                    {currentAlerts.length === 0 ? (
                        <p className="empty">No current alerts.</p>
                    ) : (
                        <ul className="alerts">
                            {currentAlerts.map((alert) => (
                                <li className={alert.severity} key={alert.id}>
                                    <a href={overviewAlertRoute(alert.kind)}>
                                        <strong>{alert.title}</strong>
                                        <br />
                                        {alert.detail}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                <section>
                    <h3>
                        <a href="#/audit">Recent tool calls</a>
                    </h3>
                    {overviewToolCalls(overview).length === 0 ? (
                        <p className="empty">No recent activity.</p>
                    ) : (
                        <ol className="feed">
                            {overviewToolCalls(overview).map((activity) => (
                                <li key={activity.callId}>
                                    <a
                                        href={webRouteHref({
                                            page: "audit",
                                            view: "call",
                                            instance: activity.instance,
                                            callId: activity.callId,
                                        })}
                                    >
                                        <time>
                                            {activity.completedAt ??
                                                activity.startedAt}
                                        </time>
                                        <strong>{activity.instance}</strong>{" "}
                                        {activity.toolName} · {activity.status}
                                    </a>
                                </li>
                            ))}
                        </ol>
                    )}
                </section>
            </div>
            <div className="overview-grid">
                <section>
                    <h3>
                        <a href="#/instances">Instances</a>
                    </h3>
                    {overview.instances.length === 0 ? (
                        <p className="empty">
                            No instances in the operational overview.
                        </p>
                    ) : (
                        <ul className="summary-list">
                            {overview.instances.slice(0, 6).map((instance) => (
                                <li key={instance.name}>
                                    <strong>{instance.name}</strong>{" "}
                                    {instance.snapshot.status} ·{" "}
                                    {instance.snapshot.connectionState} ·{" "}
                                    {instance.pendingApprovals} pending
                                    approvals
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                <section>
                    <h3>
                        <a href="#/todos">Todo summary</a>
                    </h3>
                    {overview.todos.length === 0 ? (
                        <p className="empty">No active todos.</p>
                    ) : (
                        <ul className="summary-list">
                            {overview.todos.slice(0, 6).map((todo) => (
                                <li key={`${todo.instance}-${todo.taskId}`}>
                                    <strong>{todo.title}</strong>{" "}
                                    {todo.instance} · {todo.completed}/
                                    {todo.total} complete · {todo.status}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </section>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="card">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

export function SystemResources({
    system,
    uptimeSeconds,
}: {
    system: OperationalOverviewSystem | undefined;
    uptimeSeconds: number | undefined;
}) {
    return (
        <section aria-label="Controller resources" className="resource-metrics">
            <ResourceMetric
                label="CPU"
                value={formatPercent(system?.cpuPercent)}
                detail={
                    system === undefined
                        ? "Unavailable"
                        : `${system.cpuCount} cores`
                }
            />
            <ResourceMetric
                label="Memory"
                value={formatPercent(system?.memoryPercent)}
                detail={
                    system === undefined
                        ? "Unavailable"
                        : `${formatBytes(system.memoryAvailableBytes)} available of ${formatBytes(system.memoryTotalBytes)}`
                }
            />
            <ResourceMetric
                label="Disk"
                value={formatPercent(system?.diskPercent)}
                detail={
                    system?.diskTotalBytes === undefined
                        ? "Unavailable"
                        : `${formatBytes(system.diskAvailableBytes)} available of ${formatBytes(system.diskTotalBytes)}`
                }
            />
            <ResourceMetric
                label="Load / uptime"
                value={
                    system?.load1m === undefined
                        ? "Unavailable"
                        : system.load1m.toFixed(2)
                }
                detail={formatDuration(uptimeSeconds)}
            />
        </section>
    );
}

function ResourceMetric({
    detail,
    label,
    value,
}: {
    detail: string;
    label: string;
    value: string;
}) {
    return (
        <div className="card resource-card">
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
        </div>
    );
}
