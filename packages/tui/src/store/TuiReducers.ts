import { asInstanceName, type ApprovalRequest, type ControlEventEnvelope, type InstanceSnapshot, type JsonValue, type ToolCallRecord } from "@portable-devshell/shared";

import { createEmptyInteractionState, type TuiActionMenuItem, type TuiInteractionState, type TuiUiIntent } from "../interaction/TuiInteractionTypes.js";
import type { FocusScope, PageId, SidebarFocus, TuiUiState } from "../model/TuiUiTypes.js";

export type TuiConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface TuiInstanceListEntry {
    defaultWorkspace?: string;
    enabled: boolean;
    mcpEnabled: boolean;
    mcpPath?: string;
    name: string;
    provider?: string;
}

export interface TuiLogEntry {
    at?: string;
    bytes?: number;
    callId?: string;
    instance: string;
    message?: string;
    preview?: string;
    receivedAt: string;
    requestId?: string;
    seq: number;
    sessionId?: string;
    source?: "cli" | "tui" | "mcp";
    stream: "stderr" | "stdout";
    tail?: string;
    toolName?: string;
}

export interface TuiConnectionState {
    errorCode?: string;
    errorMessage?: string;
    status: TuiConnectionStatus;
}

export interface TuiRawEventRecord {
    event: string;
    instance: string;
    payload?: JsonValue;
    seq: number;
}

export interface TuiGlobalDerivedState {
    connectedInstanceCount: number;
    pendingApprovalCount: number;
    totalEventCount: number;
}

export interface TuiAppState {
    approvalsByInstance: Record<string, ApprovalRequest[]>;
    configView?: Record<string, JsonValue>;
    connection: TuiConnectionState;
    globalDerived: TuiGlobalDerivedState;
    interaction: TuiInteractionState;
    instances: TuiInstanceListEntry[];
    lastSeqByInstance: Record<string, number>;
    lastStatusChangeAtByInstance: Record<string, string>;
    logsByInstance: Record<string, TuiLogEntry[]>;
    rawEvents: TuiRawEventRecord[];
    snapshotsByInstance: Record<string, InstanceSnapshot>;
    toolCallsByInstance: Record<string, ToolCallRecord[]>;
    ui: TuiUiState;
}

export type TuiAppAction =
    | { approvals: ApprovalRequest[]; instance: string; type: "approval.replace" }
    | { configView?: Record<string, JsonValue>; type: "control.setConfigView" }
    | { errorCode?: string; errorMessage?: string; status: TuiConnectionStatus; type: "control.setConnectionState" }
    | { focusScope: FocusScope; type: "focus.scope.set" }
    | { instance: string; seq: number; type: "instance.setLastSeq" }
    | { instances: TuiInstanceListEntry[]; type: "instance.replaceList" }
    | { entry: TuiLogEntry; type: "log.append" }
    | { instance: string; logs: TuiLogEntry[]; type: "log.replace" }
    | { type: "log.clearBuffer" }
    | { mainFocusId?: string; type: "mainFocus.set" }
    | { button: "cancel" | "confirm"; type: "confirm.focus" }
    | { items: TuiActionMenuItem[]; selectedIndex: number; title: string; type: "overlay.setActionMenu" }
    | { confirmIntent: TuiUiIntent; body: string; cancelLabel: string; confirmLabel: string; open: boolean; title: string; type: "overlay.setConfirmDialog" }
    | { sidebarFocus: SidebarFocus; type: "sidebar.focus.set" }
    | { type: "search.setOpen"; value: boolean }
    | { page: PageId; query: string; type: "search.setQuery" }
    | { page: PageId; status?: string; type: "screen.setStatus" }
    | { instance?: string; type: "ui.selectInstance" }
    | { page: PageId; type: "ui.selectPage" }
    | { key: string; type: "ui.toggleExpanded" }
    | { key: string; offset: number; type: "ui.setScrollOffset" }
    | { type: "ui.bumpRedrawNonce" }
    | { snapshot: InstanceSnapshot; type: "snapshot.replace" }
    | { instance: string; records: ToolCallRecord[]; type: "toolCall.replace" }
    | { maxEvents?: number; rawEvent: TuiRawEventRecord; type: "event.append" }
    | { type: "restore.pop" }
    | { focusScope: FocusScope; mainFocusId?: string; sidebarFocus: SidebarFocus; type: "restore.push" };

export function createInitialTuiAppState(): TuiAppState {
    return {
        approvalsByInstance: {},
        connection: {
            status: "connecting"
        },
        globalDerived: {
            connectedInstanceCount: 0,
            pendingApprovalCount: 0,
            totalEventCount: 0
        },
        interaction: createEmptyInteractionState(),
        instances: [],
        lastSeqByInstance: {},
        lastStatusChangeAtByInstance: {},
        logsByInstance: {},
        rawEvents: [],
        snapshotsByInstance: {},
        toolCallsByInstance: {},
        ui: {
            expandedBoxes: {},
            mainFocusId: undefined,
            scrollOffsets: {},
            searchQueries: {},
            selectedInstance: undefined,
            selectedPage: "instances",
            sidebarFocus: "pages"
        }
    };
}

export function tuiAppReducer(state: TuiAppState, action: TuiAppAction): TuiAppState {
    switch (action.type) {
        case "approval.replace":
            return withDerivedState({
                ...state,
                approvalsByInstance: {
                    ...state.approvalsByInstance,
                    [action.instance]: [...action.approvals].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                }
            });
        case "control.setConfigView":
            return {
                ...state,
                configView: action.configView
            };
        case "control.setConnectionState":
            return {
                ...state,
                connection: {
                    errorCode: action.errorCode,
                    errorMessage: action.errorMessage,
                    status: action.status
                }
            };
        case "focus.scope.set":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    focusScope: action.focusScope
                }
            };
        case "mainFocus.set":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    mainFocusId: action.mainFocusId
                }
            };
        case "confirm.focus":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    selectedConfirmButton: action.button
                }
            };
        case "sidebar.focus.set":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    sidebarFocus: action.sidebarFocus
                }
            };
        case "instance.replaceList":
            return withDerivedState(selectInstanceAfterListReplace({
                ...state,
                approvalsByInstance: pruneByInstances(state.approvalsByInstance, action.instances),
                instances: [...action.instances],
                lastSeqByInstance: pruneByInstanceNames(state.lastSeqByInstance, action.instances),
                lastStatusChangeAtByInstance: pruneByInstanceNames(state.lastStatusChangeAtByInstance, action.instances),
                logsByInstance: pruneByInstances(state.logsByInstance, action.instances),
                snapshotsByInstance: pruneByInstances(state.snapshotsByInstance, action.instances),
                toolCallsByInstance: pruneByInstances(state.toolCallsByInstance, action.instances)
            }));
        case "log.append": {
            const current = state.logsByInstance[action.entry.instance] ?? [];
            return withDerivedState({
                ...state,
                logsByInstance: {
                    ...state.logsByInstance,
                    [action.entry.instance]: mergeLogEntry(current, action.entry)
                }
            });
        }
        case "log.replace":
            return withDerivedState({
                ...state,
                logsByInstance: {
                    ...state.logsByInstance,
                    [action.instance]: dedupeLogs(action.logs)
                }
            });
        case "log.clearBuffer":
            return withDerivedState({
                ...state,
                logsByInstance: {}
            });
        case "overlay.setActionMenu":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    actionMenu: {
                        items: [...action.items],
                        open: action.items.length > 0,
                        selectedIndex: action.selectedIndex,
                        title: action.title
                    },
                    selectedActionId: action.items[action.selectedIndex]?.id
                }
            };
        case "overlay.setConfirmDialog":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    confirmDialog: {
                        body: action.body,
                        cancelLabel: action.cancelLabel,
                        confirmIntent: action.confirmIntent,
                        confirmLabel: action.confirmLabel,
                        open: action.open,
                        title: action.title
                    },
                    selectedConfirmButton: "cancel"
                }
            };
        case "search.setOpen":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    search: {
                        ...state.interaction.search,
                        open: action.value
                    }
                }
            };
        case "search.setQuery":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    searchQueries: {
                        ...state.ui.searchQueries,
                        [action.page]: action.query
                    }
                }
            };
        case "screen.setStatus":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    screenStatusByPage:
                        action.status === undefined
                            ? {
                                  ...state.interaction.screenStatusByPage,
                                  [action.page]: action.status
                              }
                            : {
                                  ...state.interaction.screenStatusByPage,
                                  [action.page]: action.status
                              }
                }
            };
        case "ui.selectInstance":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    selectedInstance: action.instance
                }
            };
        case "ui.selectPage":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    selectedPage: action.page
                }
            };
        case "ui.toggleExpanded":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    expandedBoxes: {
                        ...state.ui.expandedBoxes,
                        [action.key]: state.ui.expandedBoxes[action.key] !== true
                    }
                }
            };
        case "ui.setScrollOffset":
            return {
                ...state,
                ui: {
                    ...state.ui,
                    scrollOffsets: {
                        ...state.ui.scrollOffsets,
                        [action.key]: action.offset
                    }
                }
            };
        case "ui.bumpRedrawNonce":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    redrawNonce: state.interaction.redrawNonce + 1
                }
            };
        case "snapshot.replace":
            return withDerivedState({
                ...state,
                lastSeqByInstance: {
                    ...state.lastSeqByInstance,
                    [action.snapshot.name]: action.snapshot.lastSeq
                },
                snapshotsByInstance: {
                    ...state.snapshotsByInstance,
                    [action.snapshot.name]: action.snapshot
                }
            });
        case "toolCall.replace":
            return withDerivedState({
                ...state,
                toolCallsByInstance: {
                    ...state.toolCallsByInstance,
                    [action.instance]: [...action.records].sort(compareToolCallRecord)
                }
            });
        case "instance.setLastSeq":
            if ((state.lastSeqByInstance[action.instance] ?? 0) >= action.seq) {
                return state;
            }

            return {
                ...state,
                lastSeqByInstance: {
                    ...state.lastSeqByInstance,
                    [action.instance]: action.seq
                }
            };
        case "event.append": {
            const rawEvents = [...state.rawEvents, action.rawEvent];
            const maxEvents = action.maxEvents ?? 100;
            const nextState = {
                ...state,
                lastSeqByInstance:
                    (state.lastSeqByInstance[action.rawEvent.instance] ?? 0) >= action.rawEvent.seq
                        ? state.lastSeqByInstance
                        : {
                              ...state.lastSeqByInstance,
                              [action.rawEvent.instance]: action.rawEvent.seq
                          },
                rawEvents: rawEvents.slice(Math.max(0, rawEvents.length - maxEvents))
            };
            return withDerivedState(applyEventRecord(nextState, action.rawEvent));
        }
        case "restore.push":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    restoreStack: [
                        ...state.interaction.restoreStack,
                        {
                            focusScope: action.focusScope,
                            mainFocusId: action.mainFocusId,
                            sidebarFocus: action.sidebarFocus
                        }
                    ]
                }
            };
        case "restore.pop":
            return {
                ...state,
                interaction: {
                    ...state.interaction,
                    restoreStack: state.interaction.restoreStack.slice(0, -1)
                }
            };
    }
}

export function toRawEventRecord(envelope: ControlEventEnvelope): TuiRawEventRecord {
    return {
        event: envelope.event,
        instance: envelope.target.instance,
        payload: envelope.payload,
        seq: envelope.seq
    };
}

function selectInstanceAfterListReplace(state: TuiAppState): TuiAppState {
    const names = new Set(state.instances.map((instance) => instance.name));
    const selectedInstance =
        state.ui.selectedInstance !== undefined && names.has(state.ui.selectedInstance)
            ? state.ui.selectedInstance
            : state.instances[0]?.name;

    return {
        ...state,
        ui: {
            ...state.ui,
            selectedInstance
        }
    };
}

function withDerivedState(state: TuiAppState): TuiAppState {
    const pendingApprovalCount = Object.values(state.approvalsByInstance).reduce(
        (count, approvals) => count + approvals.filter((approval) => approval.status === "pending").length,
        0
    );

    return {
        ...state,
        globalDerived: {
            connectedInstanceCount: Object.values(state.snapshotsByInstance).filter((snapshot) => snapshot.connectionState === "connected").length,
            pendingApprovalCount,
            totalEventCount: state.rawEvents.length
        }
    };
}

function applyEventRecord(state: TuiAppState, rawEvent: TuiRawEventRecord): TuiAppState {
    const payload = asRecord(rawEvent.payload);
    const data = asRecord(payload?.data);

    if (payload !== undefined && typeof payload.at === "string" && isStatusEvent(rawEvent.event)) {
        state = {
            ...state,
            lastStatusChangeAtByInstance: {
                ...state.lastStatusChangeAtByInstance,
                [rawEvent.instance]: payload.at
            }
        };
    }

    if (data === undefined) {
        return state;
    }

    if (isStatusEvent(rawEvent.event)) {
        state = applySnapshotEvent(state, rawEvent.instance, rawEvent.seq, typeof payload?.at === "string" ? payload.at : undefined, data);
    }

    if (isToolCallEvent(rawEvent.event)) {
        state = applyToolCallEvent(state, rawEvent.instance, data);
    }

    if (rawEvent.event === "log.appended") {
        state = {
            ...state,
            logsByInstance: {
                ...state.logsByInstance,
                [rawEvent.instance]: mergeLogEntry(state.logsByInstance[rawEvent.instance] ?? [], {
                    at: typeof payload?.at === "string" ? payload.at : undefined,
                    bytes: typeof data.bytes === "number" ? data.bytes : undefined,
                    callId: typeof data.callId === "string" ? data.callId : undefined,
                    instance: rawEvent.instance,
                    preview: typeof data.preview === "string" ? data.preview : undefined,
                    receivedAt: typeof payload?.at === "string" ? payload.at : new Date(0).toISOString(),
                    requestId: typeof data.requestId === "string" ? data.requestId : undefined,
                    seq: rawEvent.seq,
                    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
                    source: data.source === "cli" || data.source === "tui" || data.source === "mcp" ? data.source : undefined,
                    stream: data.stream === "stderr" ? "stderr" : "stdout",
                    tail: typeof data.tail === "string" ? data.tail : undefined,
                    toolName: typeof data.toolName === "string" ? data.toolName : undefined
                })
            }
        };
    }

    if (isApprovalEvent(rawEvent.event)) {
        state = applyApprovalEvent(state, rawEvent.instance, data);
    }

    return state;
}

function applySnapshotEvent(
    state: TuiAppState,
    instance: string,
    seq: number,
    at: string | undefined,
    data: Record<string, JsonValue>
): TuiAppState {
    const current = state.snapshotsByInstance[instance];

    if (current === undefined) {
        return state;
    }

    return {
        ...state,
        lastStatusChangeAtByInstance:
            at === undefined
                ? state.lastStatusChangeAtByInstance
                : {
                      ...state.lastStatusChangeAtByInstance,
                      [instance]: at
                  },
        snapshotsByInstance: {
            ...state.snapshotsByInstance,
            [instance]: {
                ...current,
                connectionState:
                    data.connectionState === "connected" ||
                    data.connectionState === "connecting" ||
                    data.connectionState === "disconnected" ||
                    data.connectionState === "reconnecting" ||
                    data.connectionState === "failed"
                        ? data.connectionState
                        : current.connectionState,
                daemonState:
                    data.daemonState === "running" ||
                    data.daemonState === "starting" ||
                    data.daemonState === "stopped" ||
                    data.daemonState === "stale" ||
                    data.daemonState === "stopping" ||
                    data.daemonState === "failed"
                        ? data.daemonState
                        : current.daemonState,
                lastErrorCode: typeof data.lastErrorCode === "string" ? data.lastErrorCode : current.lastErrorCode,
                lastSeq: seq,
                pid: typeof data.pid === "number" ? data.pid : current.pid,
                ready: typeof data.ready === "boolean" ? data.ready : current.ready,
                status:
                    data.status === "ready" || data.status === "running" || data.status === "stale" || data.status === "stopped" || data.status === "failed"
                        ? data.status
                        : current.status
            }
        }
    };
}

function applyToolCallEvent(state: TuiAppState, instance: string, data: Record<string, JsonValue>): TuiAppState {
    const callId = typeof data.callId === "string" ? data.callId : undefined;

    if (callId === undefined) {
        return state;
    }

    const current = state.toolCallsByInstance[instance] ?? [];
    const existing = current.find((record) => record.callId === callId);
    const nextRecord: ToolCallRecord = {
        approvalId: typeof data.approvalId === "string" ? data.approvalId : existing?.approvalId,
        callId,
        completedAt: typeof data.completedAt === "string" ? data.completedAt : existing?.completedAt,
        decision: data.decision === "approved" || data.decision === "denied" || data.decision === "expired" ? data.decision : existing?.decision,
        error: typeof data.errorCode === "string" ? data.errorCode : existing?.error,
        exitCode: typeof data.exitCode === "number" || data.exitCode === null ? data.exitCode : existing?.exitCode,
        inputSummary: typeof data.inputSummary === "string" ? data.inputSummary : existing?.inputSummary ?? "",
        instance: asInstanceName(instance),
        requestId: typeof data.requestId === "string" ? data.requestId : existing?.requestId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : existing?.sessionId,
        source: data.source === "cli" || data.source === "tui" || data.source === "mcp" ? data.source : existing?.source ?? "tui",
        startedAt: typeof data.startedAt === "string" ? data.startedAt : existing?.startedAt ?? new Date(0).toISOString(),
        status:
            data.status === "pendingApproval" ||
            data.status === "running" ||
            data.status === "completed" ||
            data.status === "failed" ||
            data.status === "denied" ||
            data.status === "expired"
                ? data.status
                : existing?.status ?? "running",
        stderrBytes: typeof data.stderrBytes === "number" ? data.stderrBytes : existing?.stderrBytes,
        stdoutBytes: typeof data.stdoutBytes === "number" ? data.stdoutBytes : existing?.stdoutBytes,
        timedOut: data.timedOut === true ? true : existing?.timedOut ?? false,
        toolName: typeof data.toolName === "string" ? data.toolName : existing?.toolName ?? ""
    };

    return {
        ...state,
        toolCallsByInstance: {
            ...state.toolCallsByInstance,
            [instance]: upsertToolCall(current, nextRecord)
        }
    };
}

function applyApprovalEvent(state: TuiAppState, instance: string, data: Record<string, JsonValue>): TuiAppState {
    const approvalId = typeof data.approvalId === "string" ? data.approvalId : undefined;
    const callId = typeof data.callId === "string" ? data.callId : undefined;
    const createdAt = typeof data.createdAt === "string" ? data.createdAt : undefined;
    const expiresAt = typeof data.expiresAt === "string" ? data.expiresAt : undefined;
    const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
    const status = data.status;
    const source = data.source;
    const riskLevel = data.riskLevel;
    const current = state.approvalsByInstance[instance] ?? [];
    const existing = approvalId === undefined ? undefined : current.find((approval) => approval.approvalId === approvalId);

    if (
        approvalId === undefined ||
        callId === undefined ||
        createdAt === undefined ||
        expiresAt === undefined ||
        toolName === undefined ||
        (status !== "pending" && status !== "approved" && status !== "denied" && status !== "expired") ||
        (source !== "cli" && source !== "tui" && source !== "mcp") ||
        (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high")
    ) {
        return state;
    }

    const next: ApprovalRequest = {
        approvalId,
        callId,
        createdAt,
        decision:
            data.decision === "approve" || data.decision === "deny"
                ? {
                      approvalId,
                      decidedAt: typeof data.decidedAt === "string" ? data.decidedAt : existing?.decision?.decidedAt ?? createdAt,
                      decidedBy: data.decidedBy === "cli" || data.decidedBy === "tui" || data.decidedBy === "policy" ? data.decidedBy : "tui",
                      decision: data.decision,
                      policyPatch: data.policyPatch,
                      reason: typeof data.reason === "string" ? data.reason : undefined,
                      remember: data.remember === true ? true : undefined
                  }
                : existing?.decision,
        expiresAt,
        inputSummary: typeof data.inputSummary === "string" ? data.inputSummary : existing?.inputSummary ?? "",
        instance: asInstanceName(instance),
        reason: typeof data.reason === "string" ? data.reason : existing?.reason ?? "",
        requestId: typeof data.requestId === "string" ? data.requestId : existing?.requestId,
        riskLevel,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : existing?.sessionId,
        source,
        status,
        toolName
    };

    return {
        ...state,
        approvalsByInstance: {
            ...state.approvalsByInstance,
            [instance]: upsertApproval(current, next)
        }
    };
}

function isStatusEvent(event: string): boolean {
    return event === "instance.statusChanged" || event === "instance.connectionChanged" || event === "instance.readyChanged";
}

function isToolCallEvent(event: string): boolean {
    return (
        event === "toolCall.pendingApproval" ||
        event === "toolCall.running" ||
        event === "toolCall.completed" ||
        event === "toolCall.failed" ||
        event === "toolCall.denied" ||
        event === "toolCall.expired"
    );
}

function isApprovalEvent(event: string): boolean {
    return event === "approval.requested" || event === "approval.approved" || event === "approval.denied" || event === "approval.expired";
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function compareToolCallRecord(left: ToolCallRecord, right: ToolCallRecord): number {
    const startedAt = right.startedAt.localeCompare(left.startedAt);

    if (startedAt !== 0) {
        return startedAt;
    }

    return right.callId.localeCompare(left.callId);
}

function upsertToolCall(current: ToolCallRecord[], next: ToolCallRecord): ToolCallRecord[] {
    const without = current.filter((record) => record.callId !== next.callId);
    return [...without, next].sort(compareToolCallRecord);
}

function upsertApproval(current: ApprovalRequest[], next: ApprovalRequest): ApprovalRequest[] {
    const without = current.filter((approval) => approval.approvalId !== next.approvalId);
    return [...without, next].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function mergeLogEntry(current: TuiLogEntry[], next: TuiLogEntry): TuiLogEntry[] {
    return dedupeLogs([...current.filter((entry) => entry.seq !== next.seq), next]);
}

function dedupeLogs(logs: TuiLogEntry[]): TuiLogEntry[] {
    return [...logs]
        .sort((left, right) => {
            if (left.instance !== right.instance) {
                return left.instance.localeCompare(right.instance);
            }

            return left.seq - right.seq;
        })
        .filter((entry, index, entries) => index === 0 || !(entries[index - 1]?.instance === entry.instance && entries[index - 1]?.seq === entry.seq));
}

function pruneByInstances<T>(value: Record<string, T>, instances: TuiInstanceListEntry[]): Record<string, T> {
    const nextNames = new Set(instances.map((instance) => instance.name));
    return Object.fromEntries(Object.entries(value).filter(([name]) => nextNames.has(name)));
}

function pruneByInstanceNames<T extends string | number>(value: Record<string, T>, instances: TuiInstanceListEntry[]): Record<string, T> {
    const nextNames = new Set(instances.map((instance) => instance.name));
    return Object.fromEntries(Object.entries(value).filter(([name]) => nextNames.has(name)));
}
