import { workspaceFolderName, type ContextMessageStatus, type ToolCallRecord } from "@portable-devshell/shared";

import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../../state/route/TuiRouteState.js";
import type { TuiSidebarContextEntry } from "../../../state/TuiViewModel.js";
import { wrapTerminalText } from "../../component/TuiComponentExpandableBox.js";

export interface TuiMessageEntry {
    at: string;
    id: string;
    kind: "comment" | "report";
    status?: ContextMessageStatus;
    text: string;
}

export interface TuiMessageSession {
    ctxId: string;
    latestAt: string;
    status?: "active" | "expired" | "disabled";
    workspace?: string;
}

export function selectTuiMessageSessions(
    state: TuiAppState,
    instance: string,
): TuiMessageSession[] {
    const sessions = new Map<string, TuiMessageSession>();
    const touch = (
        ctxId: string | undefined,
        input: Partial<Omit<TuiMessageSession, "ctxId">>,
    ) => {
        if (ctxId === undefined || ctxId.length === 0) return;
        const current = sessions.get(ctxId);
        sessions.set(ctxId, {
            ctxId,
            latestAt: laterTimestamp(current?.latestAt, input.latestAt),
            status: input.status ?? current?.status,
            workspace: input.workspace ?? current?.workspace,
        });
    };

    for (const context of state.readModel.contexts) {
        const environment = context.environments.find(
            (candidate) => candidate.instance === instance,
        );
        if (environment === undefined) continue;
        touch(context.ctxId, {
            latestAt: context.lastAccessedAt || context.createdAt,
            status: context.status,
            workspace: environment.workspace ?? context.workspace,
        });
    }
    for (const message of state.readModel.instanceState[instance]?.contextMessages ?? []) {
        touch(message.ctxId, { latestAt: message.createdAt });
    }
    for (const call of state.readModel.instanceState[instance]?.reportCalls ?? []) {
        touch(call.ctxId, {
            latestAt: call.completedAt ?? call.startedAt,
            workspace: call.workspace,
        });
    }

    return [...sessions.values()].sort((left, right) =>
        right.latestAt.localeCompare(left.latestAt),
    );
}

export function selectTuiMessagesSidebarEntries(
    state: TuiAppState,
    focused: boolean,
    cursor: TuiAppState["interaction"]["sidebarCursor"],
): TuiSidebarContextEntry[] {
    const route = currentTuiRoute(state);
    const instance = state.ui.selectedInstance;
    const sessions = instance === undefined
        ? []
        : selectTuiMessageSessions(state, instance);
    const baseLabels = sessions.map((session) =>
        session.workspace === undefined
            ? compactContextId(session.ctxId)
            : workspaceFolderName(session.workspace),
    );
    const labelCounts = new Map<string, number>();
    for (const label of baseLabels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    return [
        {
            focused:
                focused && cursor?.kind === "context" && cursor.id === "messages:back",
            id: "messages:back",
            label: "← messages",
            selected: route.page === "messages" && route.view === "contexts",
            target: { kind: "root" },
        },
        ...sessions.map((session, index): TuiSidebarContextEntry => {
            const baseLabel = baseLabels[index] ?? compactContextId(session.ctxId);
            const label = (labelCounts.get(baseLabel) ?? 0) > 1
                ? `${baseLabel} · ${compactContextId(session.ctxId)}`
                : baseLabel;
            return {
                focused:
                    focused &&
                    cursor?.kind === "context" &&
                    cursor.id === `messages:context:${session.ctxId}`,
                id: `messages:context:${session.ctxId}`,
                label,
                selected:
                    route.page === "messages" &&
                    route.view === "thread" &&
                    route.ctxId === session.ctxId,
                target: {
                    kind: "route",
                    route: {
                        ctxId: session.ctxId,
                        page: "messages",
                        view: "thread",
                    },
                },
            };
        }),
    ];
}

export function selectTuiMessageEntries(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): TuiMessageEntry[] {
    const comments: TuiMessageEntry[] = (
        state.readModel.instanceState[instance]?.contextMessages ?? []
    )
        .filter((message) => message.ctxId === ctxId)
        .map((message) => ({
            at: message.createdAt,
            id: `comment:${message.id}`,
            kind: "comment" as const,
            status: message.status,
            text: message.text,
        }));
    const reports: TuiMessageEntry[] = (
        state.readModel.instanceState[instance]?.reportCalls ?? []
    )
        .filter(
            (call) =>
                call.ctxId === ctxId &&
                call.toolName === "todo_report" &&
                call.status === "completed",
        )
        .flatMap((call) => {
            const text = reportText(call);
            return text === undefined
                ? []
                : [{
                      at: call.completedAt ?? call.startedAt,
                      id: `report:${call.callId}`,
                      kind: "report" as const,
                      text,
                  }];
        });

    return [...comments, ...reports].sort(
        (left, right) =>
            left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );
}

export function renderTuiMessageHistoryLines(
    state: TuiAppState,
    instance: string,
    ctxId: string,
    width: number,
): Array<{ kind: "meta" | "text"; text: string }> {
    const innerWidth = Math.max(1, width - 2);
    return selectTuiMessageEntries(state, instance, ctxId).flatMap((entry) => [
        {
            kind: "meta" as const,
            text: `${entry.kind === "comment" ? "You" : "Agent"}  ${formatMessageTime(entry.at)}${entry.kind === "comment" && entry.status !== "delivered" ? `  ${entry.status ?? ""}` : ""}`,
        },
        ...wrapTerminalText(entry.text, innerWidth).map((line) => ({
            kind: "text" as const,
            text: `  ${line}`,
        })),
        { kind: "text" as const, text: "" },
    ]);
}

export function tuiMessagesHistoryRows(viewportRows: number): number {
    return Math.max(0, viewportRows - 4);
}

function reportText(call: ToolCallRecord): string | undefined {
    if (
        typeof call.input !== "object" ||
        call.input === null ||
        Array.isArray(call.input)
    ) {
        return undefined;
    }
    const message = call.input.message;
    return typeof message === "string" && message.length > 0 ? message : undefined;
}

function laterTimestamp(left: string | undefined, right: string | undefined): string {
    if (left === undefined) return right ?? "";
    if (right === undefined) return left;
    return left.localeCompare(right) >= 0 ? left : right;
}

function formatMessageTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function compactContextId(ctxId: string): string {
    return ctxId.length <= 12 ? ctxId : `${ctxId.slice(0, 8)}…`;
}
