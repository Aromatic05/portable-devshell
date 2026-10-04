import type { JsonValue } from "@portable-devshell/shared";

export interface WorkspaceSnapshot {
    ctxId: string;
    instance: string;
    cursor: number;
    agentBusy: boolean;
    presentation: WorkspacePresentation;
    modelContext: WorkspaceHostModelContext;
    reentry: WorkspaceReentryView;
}

export interface WorkspacePresentation {
    primary?: WorkspacePrimaryItem;
    work: WorkspaceWorkItem[];
    background: WorkspaceBackgroundItem[];
}

export type WorkspacePrimaryItem = WorkspaceDecisionItem;
export type WorkspaceItem = WorkspacePrimaryItem | WorkspaceWorkItem | WorkspaceBackgroundItem;

export interface WorkspaceDecisionItem {
    kind: "decision";
    id: string;
    title: string;
    badge?: string;
    summary?: string;
    detail?: string;
    actions: WorkspaceAction[];
}

export interface WorkspaceWorkItem {
    kind: "work";
    id: string;
    title: string;
    state: "running" | "paused" | "blocked";
    badge?: string;
    detail?: string;
    current?: string;
    note?: string;
    progress?: { current: number; total: number };
    actions: WorkspaceAction[];
}

export interface WorkspaceBackgroundItem {
    kind: "background";
    id: string;
    title: string;
    badge?: string;
    summary?: string;
    detail?: string;
    actions: WorkspaceAction[];
}

export interface WorkspaceAction {
    id: string;
    label: string;
    tone?: "default" | "primary" | "danger";
    confirmation?: { message: string };
    input?: WorkspaceActionInput;
}

export interface WorkspaceChoice {
    id: string;
    label: string;
}

export type WorkspaceActionInput =
    | { kind: "none" }
    | { kind: "text"; placeholder?: string }
    | { kind: "choice"; choices: WorkspaceChoice[] };

export interface WorkspaceActionRequest {
    itemId: string;
    actionId: string;
    input?: string;
}

export interface WorkspaceActionResult {
    status: "applied" | "stale";
    snapshot: WorkspaceSnapshot;
    effect?: WorkspaceActionEffect;
}

export type WorkspaceActionEffect = WorkspaceReentryDirective;

export interface WorkspaceReentryDirective {
    kind: "reentry";
    intent: "automatic" | "goal-resume" | "goal-retry" | "task-resume";
    sourceId?: string;
    id?: string;
}

export interface WorkspaceHostModelContext {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: { portableDevshellWorkspace: JsonValue };
}

export interface WorkspaceReentryView {
    pending: boolean;
    executionActive?: boolean;
    schedule?: { readyAt: string; intent: "automatic"; sourceId?: string };
    delivery?: { status: "idle" | "uncertain" | "paused" };
    directives?: WorkspaceReentryDirective[];
}

export type WorkspaceActionOperation =
    | "task-pause" | "task-resume" | "task-cancel"
    | "approval-approve" | "approval-deny"
    | "goal-pause" | "goal-resume" | "goal-retry" | "goal-stop";

export interface WorkspaceResolvedAction {
    itemId: string;
    actionId: string;
    instance: string;
    operation: WorkspaceActionOperation;
    targetId: string;
    revision?: number;
}
