import type { JsonValue } from "@portable-devshell/shared";
import type { McpAppActivity } from "../Activity.js";

export interface McpAppSnapshot {
    ctxId: string;
    instance: string;
    cursor: number;
    agentBusy: boolean;
    activity?: McpAppActivity[];
    presentation: McpAppPresentation;
    modelContext: McpAppHostModelContext;
    reentry: McpAppReentryView;
}

export interface McpAppPresentation {
    primary?: McpAppPrimaryItem;
    work: McpAppWorkItem[];
    background: McpAppBackgroundItem[];
}

export type McpAppPrimaryItem = McpAppDecisionItem;
export type McpAppItem = McpAppPrimaryItem | McpAppWorkItem | McpAppBackgroundItem;

export interface McpAppDecisionItem {
    kind: "decision";
    id: string;
    title: string;
    badge?: string;
    summary?: string;
    detail?: string;
    actions: McpAppAction[];
}

export interface McpAppWorkItem {
    kind: "work";
    id: string;
    title: string;
    state: "running" | "paused" | "blocked";
    badge?: string;
    detail?: string;
    current?: string;
    note?: string;
    progress?: { current: number; total: number };
    actions: McpAppAction[];
}

export interface McpAppBackgroundItem {
    kind: "background";
    id: string;
    title: string;
    badge?: string;
    summary?: string;
    detail?: string;
    actions: McpAppAction[];
}

export interface McpAppAction {
    id: string;
    label: string;
    expectedRevision?: number;
    tone?: "default" | "primary" | "danger";
    confirmation?: { message: string };
}

export interface McpAppActionRequest {
    itemId: string;
    actionId: string;
    expectedRevision?: number;
    requestId?: string;
}

export interface McpAppActionResult {
    status: "applied" | "stale";
    snapshot: McpAppSnapshot;
    effect?: McpAppActionEffect;
}

export type McpAppActionEffect = McpAppReentryDirective;

export interface McpAppReentryDirective {
    kind: "reentry";
    intent: "automatic" | "goal-resume" | "goal-retry" | "task-resume";
    sourceId?: string;
    id?: string;
}

export interface McpAppHostModelContext {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: { portableDevshellMcpApp: JsonValue };
}

export interface McpAppReentryView {
    pending: boolean;
    executionActive?: boolean;
    schedule?: { readyAt: string; intent: "automatic"; sourceId?: string };
    delivery?: { status: "idle" | "uncertain" | "paused" };
    directives?: McpAppReentryDirective[];
}

export type McpAppActionOperation =
    | "task-pause" | "task-resume" | "task-cancel"
    | "approval-approve" | "approval-deny"
    | "goal-pause" | "goal-resume" | "goal-retry" | "goal-stop";

export interface McpAppResolvedAction {
    itemId: string;
    actionId: string;
    instance: string;
    operation: McpAppActionOperation;
    targetId: string;
    revision?: number;
}
