import type {
    OperationalOverview,
    OperationalOverviewActivity,
    OperationalOverviewAlert,
    OperationalOverviewInstance,
    OperationalOverviewTodo
} from "@portable-devshell/shared";

const alertLimit = 6;
const activityLimit = 8;
const healthyInstanceLimit = 4;
const todoLimit = 8;

export interface TuiOverviewPresentation {
    activity: readonly OperationalOverviewActivity[];
    alerts: readonly OperationalOverviewAlert[];
    instances: readonly OperationalOverviewInstance[];
    omitted: {
        activity: number;
        alerts: number;
        instances: number;
        todos: number;
    };
    todos: readonly OperationalOverviewTodo[];
}

export function selectTuiOverviewPresentation(
    overview: OperationalOverview
): TuiOverviewPresentation {
    const alerts = [...overview.alerts]
        .sort((left, right) => {
            const severity = alertRank(left) - alertRank(right);
            return severity === 0 ? left.id.localeCompare(right.id) : severity;
        });
    const orderedInstances = [...overview.instances].sort((left, right) => {
        const health = instanceRank(left) - instanceRank(right);
        return health === 0 ? left.name.localeCompare(right.name) : health;
    });
    const attentionInstances = orderedInstances.filter((instance) => !instance.snapshot.ready);
    const healthyInstances = orderedInstances
        .filter((instance) => instance.snapshot.ready)
        .slice(0, healthyInstanceLimit);
    const instances = [...attentionInstances, ...healthyInstances];
    const activity = overview.activity.slice(0, activityLimit);
    const actionableTodos = overview.todos
        .filter((todo) => todo.status === "failed" || todo.status === "blocked" || todo.status === "in_progress")
        .sort((left, right) => {
            const status = todoRank(left) - todoRank(right);
            return status === 0 ? left.title.localeCompare(right.title) : status;
        });
    const todos = actionableTodos.slice(0, todoLimit);

    return {
        activity,
        alerts: alerts.slice(0, alertLimit),
        instances,
        omitted: {
            activity: Math.max(0, overview.activity.length - activity.length),
            alerts: Math.max(0, alerts.length - alertLimit),
            instances: Math.max(0, overview.instances.length - instances.length),
            todos: Math.max(0, actionableTodos.length - todos.length)
        },
        todos
    };
}

function alertRank(alert: OperationalOverviewAlert): number {
    return alert.severity === "critical" ? 0 : 1;
}

function instanceRank(instance: OperationalOverviewInstance): number {
    const snapshot = instance.snapshot;
    if (snapshot.status === "failed" || snapshot.connectionState === "failed" || snapshot.daemonState === "failed") {
        return 0;
    }
    return snapshot.ready ? 2 : 1;
}

function todoRank(todo: OperationalOverviewTodo): number {
    switch (todo.status) {
        case "failed":
            return 0;
        case "blocked":
            return 1;
        case "in_progress":
            return 2;
        default:
            return 3;
    }
}
