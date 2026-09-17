import {
    compactContextId,
    parseContextMessageDirective,
    workspaceFolderName,
    type ContextMessageStatus,
    type ConversationEntry,
} from "@portable-devshell/shared";

import type { TuiAppState } from "../../../../state/store/Model.js";
import { currentTuiRoute } from "../../../../state/route/State.js";
import {
    nextTuiGraphemeCursor,
    normalizeTuiGraphemeCursor,
} from "../../../../interaction/selection/Model.js";
import type { TuiSidebarContextEntry } from "../../../../state/Ui.js";
import { wrapTerminalText } from "../../../component/content/Box.js";

export interface TuiMessageEntry {
    at: string;
    id: string;
    kind: "comment" | "report";
    status?: ContextMessageStatus;
    text: string;
}

export interface TuiMessageSession {
    ctxId: string;
    instance: string;
    latestAt: string;
    startedAt: string;
    status?: "active" | "expired" | "disabled";
    title: string;
    workspace?: string;
}

export interface TuiMessageComposerSegment {
    text: string;
    underline?: boolean;
}

const activeSessionWindowMs = 30 * 60 * 1_000;
const emptyConversationEntries = Object.freeze(
    [],
) as readonly ConversationEntry[];
const messageHistoryCache = new WeakMap<
    readonly ConversationEntry[],
    Map<string, Array<{ kind: "meta" | "text"; text: string }>>
>();
let messageSessionCache:
    | {
          contexts: TuiAppState["readModel"]["contexts"];
          instanceState: TuiAppState["readModel"]["instanceState"];
          preferences: TuiAppState["conversationPreferences"];
          sessions: TuiMessageSession[];
      }
    | undefined;

export function selectTuiMessageSessions(
    state: TuiAppState,
    now: number = Date.now(),
): TuiMessageSession[] {
    return projectTuiMessageSessions(state).filter(
        (session) =>
            state.conversationPreferences.hiddenContexts[session.ctxId] !==
                true && isActiveMessageSession(session, now),
    );
}

export function selectTuiMessageHistorySessions(
    state: TuiAppState,
    now: number = Date.now(),
): TuiMessageSession[] {
    return projectTuiMessageSessions(state).filter(
        (session) =>
            state.conversationPreferences.hiddenContexts[session.ctxId] !==
                true && !isActiveMessageSession(session, now),
    );
}

export function selectTuiMessageHiddenSessions(
    state: TuiAppState,
): TuiMessageSession[] {
    return projectTuiMessageSessions(state).filter(
        (session) =>
            state.conversationPreferences.hiddenContexts[session.ctxId] ===
            true,
    );
}

function projectTuiMessageSessions(state: TuiAppState): TuiMessageSession[] {
    if (
        messageSessionCache?.contexts === state.readModel.contexts &&
        messageSessionCache.instanceState === state.readModel.instanceState &&
        messageSessionCache.preferences === state.conversationPreferences
    )
        return messageSessionCache.sessions;
    const sessions = new Map<string, Omit<TuiMessageSession, "title">>();
    const summaries = new Map<string, { at: string; text: string }>();
    const touch = (
        instance: string,
        ctxId: string | undefined,
        input: Partial<Omit<TuiMessageSession, "ctxId" | "instance" | "title">>,
    ) => {
        if (ctxId === undefined || ctxId.length === 0) return;
        const key = conversationKey(instance, ctxId);
        const current = sessions.get(key);
        sessions.set(key, {
            ctxId,
            instance,
            latestAt: laterTimestamp(current?.latestAt, input.latestAt),
            startedAt: earlierTimestamp(current?.startedAt, input.startedAt),
            status: input.status ?? current?.status,
            workspace: input.workspace ?? current?.workspace,
        });
    };

    for (const context of state.readModel.contexts) {
        const environments = context.environments ?? [
            { instance: context.instance, workspace: context.workspace },
        ];
        for (const environment of environments) {
            touch(environment.instance, context.ctxId, {
                latestAt: context.lastAccessedAt || context.createdAt,
                startedAt: context.createdAt,
                status: context.status,
                workspace: environment.workspace ?? context.workspace,
            });
        }
    }
    for (const [instance, instanceState] of Object.entries(
        state.readModel.instanceState,
    )) {
        for (const entry of instanceState.conversationEntries) {
            touch(instance, entry.ctxId, {
                latestAt: entry.createdAt,
                startedAt: entry.createdAt,
            });
            if (entry.kind !== "comment") continue;
            const text = conversationSummary(entry.text);
            if (text === undefined) continue;
            const key = conversationKey(instance, entry.ctxId);
            const current = summaries.get(key);
            if (
                current === undefined ||
                entry.createdAt.localeCompare(current.at) < 0
            ) {
                summaries.set(key, { at: entry.createdAt, text });
            }
        }
    }

    const values = [...sessions.values()];
    const baseTitles = values.map((session) => {
        const key = conversationKey(session.instance, session.ctxId);
        return (
            state.conversationPreferences.titles[key] ??
            summaries.get(key)?.text ??
            compactContextId(session.ctxId, 12)
        );
    });
    const titleCounts = new Map<string, number>();
    for (const title of baseTitles) {
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }
    const projected = values
        .map((session, index): TuiMessageSession => {
            const baseTitle =
                baseTitles[index] ?? compactContextId(session.ctxId, 12);
            return {
                ...session,
                title:
                    (titleCounts.get(baseTitle) ?? 0) > 1
                        ? `${baseTitle} · ${compactContextId(session.ctxId, 8)}`
                        : baseTitle,
            };
        })
        .sort((left, right) => compareMessageSessions(state, left, right));
    messageSessionCache = {
        contexts: state.readModel.contexts,
        instanceState: state.readModel.instanceState,
        preferences: state.conversationPreferences,
        sessions: projected,
    };
    return projected;
}

export function selectTuiMessagesSidebarEntries(
    state: TuiAppState,
    focused: boolean,
    cursor: TuiAppState["interaction"]["sidebarCursor"],
    now: number = Date.now(),
): TuiSidebarContextEntry[] {
    const route = currentTuiRoute(state);
    const scope = state.ui.messageScope;
    const allSessions = projectTuiMessageSessions(state);
    const scopedSessions =
        scope === "active"
            ? allSessions.filter(
                  (session) =>
                      state.conversationPreferences.hiddenContexts[
                          session.ctxId
                      ] !== true && isActiveMessageSession(session, now),
              )
            : scope === "history"
              ? allSessions.filter(
                    (session) =>
                        state.conversationPreferences.hiddenContexts[
                            session.ctxId
                        ] !== true && !isActiveMessageSession(session, now),
                )
              : allSessions.filter(
                    (session) =>
                        state.conversationPreferences.hiddenContexts[
                            session.ctxId
                        ] === true,
                );
    const sessions = filterMessageSessions(
        scopedSessions,
        state.ui.searchQueries.messages ?? "",
    );
    const allByWorkspace = groupMessageSessions(allSessions);
    const visibleGroups = groupMessageSessions(sessions);
    const sessionEntries = visibleGroups.flatMap((group) => {
        const projectId = `messages:project:${encodeURIComponent(group.key)}`;
        const collapsed =
            state.ui.messageCollapsedWorkspaces[group.key] === true;
        const allProjectSessions =
            allByWorkspace.find((candidate) => candidate.key === group.key)
                ?.sessions ?? group.sessions;
        const project: TuiSidebarContextEntry = {
            focused:
                focused &&
                cursor?.kind === "context" &&
                cursor.id === projectId,
            id: projectId,
            label: `${collapsed ? "▸" : "▾"} ${group.label}`,
            selected: false,
            target: {
                ctxIds: [
                    ...new Set(
                        allProjectSessions.map((session) => session.ctxId),
                    ),
                ],
                kind: "messageProject",
                workspaceKey: group.key,
            },
        };
        if (collapsed) return [project];
        return [
            project,
            ...group.sessions.map((session): TuiSidebarContextEntry => {
                const id = sidebarSessionId(session);
                return {
                    focused:
                        focused &&
                        cursor?.kind === "context" &&
                        cursor.id === id,
                    id,
                    label: `  ${session.title}`,
                    selected:
                        route.page === "messages" &&
                        route.view === "thread" &&
                        route.ctxId === session.ctxId &&
                        route.instance === session.instance,
                    target: {
                        instance: session.instance,
                        kind: "messageConversation",
                        route: {
                            ctxId: session.ctxId,
                            instance: session.instance,
                            page: "messages",
                            view: "thread",
                        },
                    },
                };
            }),
        ];
    });

    return [
        {
            focused:
                focused &&
                cursor?.kind === "context" &&
                cursor.id === "messages:back",
            id: "messages:back",
            label: "← messages",
            selected: route.page === "messages" && route.view === "contexts",
            target: { kind: "root" },
        },
        ...(["active", "history", "hidden"] as const).map(
            (candidate): TuiSidebarContextEntry => ({
                focused:
                    focused &&
                    cursor?.kind === "context" &&
                    cursor.id === `messages:scope:${candidate}`,
                id: `messages:scope:${candidate}`,
                label:
                    candidate === "active"
                        ? "Current"
                        : candidate === "history"
                          ? "History"
                          : "Hidden",
                selected: scope === candidate,
                target: { kind: "messageScope", scope: candidate },
            }),
        ),
        ...sessionEntries,
    ];
}

function filterMessageSessions(
    sessions: readonly TuiMessageSession[],
    query: string,
): TuiMessageSession[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [...sessions];
    return sessions.filter((session) =>
        [
            session.title,
            session.ctxId,
            session.instance,
            session.workspace,
            session.status,
        ].some((value) => value?.toLowerCase().includes(needle) === true),
    );
}

function groupMessageSessions(sessions: readonly TuiMessageSession[]): Array<{
    key: string;
    label: string;
    sessions: TuiMessageSession[];
}> {
    const groups = new Map<
        string,
        { key: string; label: string; sessions: TuiMessageSession[] }
    >();
    for (const session of sessions) {
        const key = workspacePreferenceKey(session);
        const current = groups.get(key) ?? {
            key,
            label:
                session.workspace === undefined
                    ? session.instance
                    : workspaceFolderName(session.workspace),
            sessions: [],
        };
        current.sessions.push(session);
        groups.set(key, current);
    }
    return [...groups.values()];
}

function compareMessageSessions(
    state: TuiAppState,
    left: TuiMessageSession,
    right: TuiMessageSession,
): number {
    const leftWorkspace = workspacePreferenceKey(left);
    const rightWorkspace = workspacePreferenceKey(right);
    const workspaceRank = new Map(
        state.conversationPreferences.workspaceOrder.map((key, index) => [
            key,
            index,
        ]),
    );
    const leftWorkspaceRank = workspaceRank.get(leftWorkspace);
    const rightWorkspaceRank = workspaceRank.get(rightWorkspace);
    if (leftWorkspaceRank !== rightWorkspaceRank) {
        if (leftWorkspaceRank === undefined) return 1;
        if (rightWorkspaceRank === undefined) return -1;
        return leftWorkspaceRank - rightWorkspaceRank;
    }
    if (leftWorkspace !== rightWorkspace) {
        return leftWorkspace.localeCompare(rightWorkspace);
    }
    const order =
        state.conversationPreferences.orderByWorkspace[leftWorkspace] ?? [];
    const leftRank = order.indexOf(conversationKey(left.instance, left.ctxId));
    const rightRank = order.indexOf(
        conversationKey(right.instance, right.ctxId),
    );
    if (leftRank !== rightRank) {
        if (leftRank < 0) return 1;
        if (rightRank < 0) return -1;
        return leftRank - rightRank;
    }
    return (
        right.startedAt.localeCompare(left.startedAt) ||
        left.ctxId.localeCompare(right.ctxId)
    );
}

function conversationKey(instance: string, ctxId: string): string {
    return `${instance}\u0000${ctxId}`;
}

function workspacePreferenceKey(session: TuiMessageSession): string {
    return session.workspace ?? `\u0000${session.instance}`;
}

function sidebarSessionId(session: TuiMessageSession): string {
    return `messages:context:${encodeURIComponent(session.instance)}:${encodeURIComponent(session.ctxId)}`;
}

function isActiveMessageSession(
    session: TuiMessageSession,
    now: number,
): boolean {
    return Date.parse(session.latestAt) >= now - activeSessionWindowMs;
}

export function selectTuiMessageEntries(
    state: TuiAppState,
    instance: string,
    ctxId: string,
): TuiMessageEntry[] {
    return selectTuiMessageEntriesFromSource(
        state.readModel.instanceState[instance]?.conversationEntries ??
            emptyConversationEntries,
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
                left.at.localeCompare(right.at) ||
                left.id.localeCompare(right.id),
        );
}

export function renderTuiMessageHistoryLines(
    state: TuiAppState,
    instance: string,
    ctxId: string,
    width: number,
): Array<{ kind: "meta" | "text"; text: string }> {
    const innerWidth = Math.max(1, width - 2);
    const source =
        state.readModel.instanceState[instance]?.conversationEntries ??
        emptyConversationEntries;
    let byContextAndWidth = messageHistoryCache.get(source);
    if (byContextAndWidth === undefined) {
        byContextAndWidth = new Map();
        messageHistoryCache.set(source, byContextAndWidth);
    }
    const cacheKey = `${ctxId}\u0000${innerWidth}`;
    const cached = byContextAndWidth.get(cacheKey);
    if (cached !== undefined) return cached;
    const rendered = selectTuiMessageEntriesFromSource(source, ctxId).flatMap(
        (entry) => [
            {
                kind: "meta" as const,
                text: `${entry.kind === "comment" ? "You" : "Agent"}  ${formatMessageTime(entry.at)}${entry.kind === "comment" && entry.status !== "delivered" ? `  ${entry.status ?? ""}` : ""}`,
            },
            ...wrapTerminalText(entry.text, innerWidth).map((line) => ({
                kind: "text" as const,
                text: `  ${line}`,
            })),
            { kind: "text" as const, text: " " },
        ],
    );
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
        {
            text: cursor === draft.length ? " " : draft.slice(cursor, next),
            underline: visible || undefined,
        },
        { text: draft.slice(next) },
    ];
}

function laterTimestamp(
    left: string | undefined,
    right: string | undefined,
): string {
    if (left === undefined) return right ?? "";
    if (right === undefined) return left;
    return left.localeCompare(right) >= 0 ? left : right;
}

function earlierTimestamp(
    left: string | undefined,
    right: string | undefined,
): string {
    if (left === undefined) return right ?? "";
    if (right === undefined) return left;
    return left.localeCompare(right) <= 0 ? left : right;
}

function conversationSummary(text: string): string | undefined {
    const compact = parseContextMessageDirective(text)
        .body.replace(/\s+/gu, " ")
        .trim();
    if (compact.length === 0) return undefined;
    return compact.length <= 64
        ? compact
        : `${compact.slice(0, 61).trimEnd()}…`;
}

function formatMessageTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
