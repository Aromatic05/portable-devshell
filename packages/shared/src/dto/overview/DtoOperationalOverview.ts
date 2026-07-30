import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";
import type { InstanceSnapshot } from "../instance/DtoInstanceSnapshot.js";
import type { ActiveTodoSummary } from "../instance/DtoTodo.js";
import type {
    ToolCallSource,
    ToolCallStatus
} from "../tool/DtoToolCallRecord.js";

export type OperationalHealth = "healthy" | "attention" | "critical";
export type OperationalAlertSeverity = "attention" | "critical";

export interface OperationalOverviewSystem {
    cpuCount: number;
    cpuPercent?: number;
    diskAvailableBytes?: number;
    diskPath?: string;
    diskPercent?: number;
    diskTotalBytes?: number;
    load1m?: number;
    memoryAvailableBytes: number;
    memoryPercent: number;
    memoryTotalBytes: number;
}

export interface OperationalOverviewController {
    pid: number;
    system?: OperationalOverviewSystem;
    uptimeSeconds: number;
}

export interface OperationalOverviewCounts {
    activeTodos: number;
    failedCalls24h: number;
    instancesAttention: number;
    instancesCritical: number;
    instancesReady: number;
    instancesTotal: number;
    pendingApprovals: number;
}

export interface OperationalOverviewInstance {
    mcpEnabled: boolean;
    name: InstanceName;
    pendingApprovals: number;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    snapshot: InstanceSnapshot;
    workspace?: string;
}

export interface OperationalOverviewTodo extends ActiveTodoSummary {
    instance: InstanceName;
}

export interface OperationalOverviewActivity {
    callId: string;
    completedAt?: string;
    errorSummary?: string;
    instance: InstanceName;
    source: ToolCallSource;
    startedAt: string;
    status: ToolCallStatus;
    toolName: string;
}

export interface OperationalOverviewAlert {
    detail: string;
    id: string;
    instance?: InstanceName;
    kind:
        | "activity.failed"
        | "approval.oauthPending"
        | "approval.pending"
        | "controller.diskPressure"
        | "controller.memoryPressure"
        | "instance.attention"
        | "instance.failed"
        | "overview.partial"
        | "todo.blocked"
        | "todo.failed";
    severity: OperationalAlertSeverity;
    title: string;
}

export interface OperationalOverview {
    activity: OperationalOverviewActivity[];
    alerts: OperationalOverviewAlert[];
    controller: OperationalOverviewController;
    counts: OperationalOverviewCounts;
    generatedAt: string;
    health: OperationalHealth;
    instances: OperationalOverviewInstance[];
    todos: OperationalOverviewTodo[];
}
