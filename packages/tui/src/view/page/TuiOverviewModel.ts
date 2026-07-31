export type TuiOverviewTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export interface TuiOverviewMeterModel {
    readonly detail: string;
    readonly label: string;
    readonly percent?: number;
    readonly tone: TuiOverviewTone;
    readonly value: string;
}

export interface TuiOverviewInstanceRowModel {
    readonly approvals: number;
    readonly connection: string;
    readonly daemon: string;
    readonly focused: boolean;
    readonly id: string;
    readonly lastError?: string;
    readonly mcpEnabled: boolean;
    readonly name: string;
    readonly provider: string;
    readonly runtime: string;
    readonly todos: number;
    readonly tone: TuiOverviewTone;
    readonly workspace?: string;
}

export interface TuiOverviewAlertRowModel {
    readonly detail: string;
    readonly id: string;
    readonly instance?: string;
    readonly title: string;
    readonly tone: TuiOverviewTone;
}

export interface TuiOverviewActivityRowModel {
    readonly callId: string;
    readonly duration: string;
    readonly instance: string;
    readonly startedAt: string;
    readonly status: string;
    readonly tone: TuiOverviewTone;
    readonly toolName: string;
}

export interface TuiOverviewPresentation {
    readonly activity: readonly TuiOverviewActivityRowModel[];
    readonly alerts: readonly TuiOverviewAlertRowModel[];
    readonly available: boolean;
    readonly controller: {
        readonly pid?: number;
        readonly summary: string;
        readonly uptime: string;
    };
    readonly counts: {
        readonly activeTodos: number;
        readonly failedCalls24h: number;
        readonly instancesAttention: number;
        readonly instancesCritical: number;
        readonly instancesReady: number;
        readonly instancesTotal: number;
        readonly pendingApprovals: number;
    };
    readonly generatedAt?: string;
    readonly health: "healthy" | "attention" | "critical" | "unavailable";
    readonly instances: readonly TuiOverviewInstanceRowModel[];
    readonly meters: readonly TuiOverviewMeterModel[];
    readonly query: string;
}
