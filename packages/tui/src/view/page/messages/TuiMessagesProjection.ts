import {
    workspaceFolderName,
    type ContextMessageStatus,
    type ConversationEntry,
} from "@portable-devshell/shared";

import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../../state/route/TuiRouteState.js";
import {
    nextTuiGraphemeCursor,
    normalizeTuiGraphemeCursor,
} from "../../../state/TuiGraphemeCursor.js";
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

export interface TuiMessageComposerSegment {
    text: string;
    underline?: boolean;
}

const activeSessionWindowMs = 30 * 60 * 1_000;
const emptyConversationEntries = Object.freeze([]) as readonly ConversationEntry[];
const messageHistoryCache = new WeakMap<
    readonly ConversationEntry[],
    Map<string, Array<{ kind: "meta" | "text"; text: string }>>
>();

export function selectTuiMessageSessions(
    state: TuiAppState,
    instance: string,
    now: number = Date.now(),
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
    for (const entry of state.readModel.instanceState[instance]?.conversationEntries ?? []) {
        touch(entry.ctxId, { latestAt: entry.createdAt });
    }

    return [...sessions.values()]
        .filter((session) => Date.parse(session.latestAt) >= now - activeSessionWindowMs)
        .sort((left, right) =>
            right.latestAt.localeCompare(left.latestAt),
        );
}

export function selectTuiMessagesSidebarEntries(
    state: TuiAppState,
    focused: boolean,
    cursor: TuiAppState["interaction"]["sidebarCursor"],
    now: number = Date.now(),
): TuiSidebarContextEntry[] {
    const route = currentTuiRoute(state);
    const instance = state.ui.selectedInstance;
    const sessions = instance === undefined
        ? []
        : selectTuiMessageSessions(state, instance, now);
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
    return selectTuiMessageEntriesFromSource(
        state.readModel.instanceState[instance]?.conversationEntries ?? emptyConversationEntries,
        ctxId,
    );
}

function selectTuiMessageEntriesFromSource(
    entries: readonly ConversationEntry[],
    ctxId: string,
): TuiMessageEntry[] {
    return entries
        .filter((entry) => entry.ctxId === ctxId)
        .map((entry): TuiMessageEntry => ({
            at: entry.createdAt,
            id: `${entry.kind}:${entry.id}`,
            kind: entry.kind,
            ...(entry.status === undefined ? {} : { status: entry.status }),
            text: entry.text,
        }))
        .sort(
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
    const source = state.readModel.instanceState[instance]?.conversationEntries ?? emptyConversationEntries;
    let byContextAndWidth = messageHistoryCache.get(source);
    if (byContextAndWidth === undefined) {
        byContextAndWidth = new Map();
        messageHistoryCache.set(source, byContextAndWidth);
    }
    const cacheKey = `${ctxId}\u0000${innerWidth}`;
    const cached = byContextAndWidth.get(cacheKey);
    if (cached !== undefined) return cached;
    const rendered = selectTuiMessageEntriesFromSource(source, ctxId).flatMap((entry) => [
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
    byContextAndWidth.set(cacheKey, rendered);
    return rendered;
}

export function tuiMessagesHistoryRows(viewportRows: number): number {
    return Math.max(0, viewportRows - 4);
}

export function tuiMessagesRenderedHistoryRows(
    historyLineCount: number,
    viewportRows: number,
): number {
    const maximum = tuiMessagesHistoryRows(viewportRows);
    if (maximum === 0) return 0;
    return Math.min(maximum, Math.max(1, historyLineCount));
}

export function renderTuiMessageComposerSegments(
    draft: string,
    requestedCursor: number,
    visible: boolean,
): TuiMessageComposerSegment[] {
    const cursor = normalizeTuiGraphemeCursor(draft, requestedCursor);
    const next = nextTuiGraphemeCursor(draft, cursor);
    return [
        { text: draft.slice(0, cursor) },
        { text: cursor === draft.length ? " " : draft.slice(cursor, next), underline: visible || undefined },
        { text: draft.slice(next) },
    ];
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
