import {
    compactContextId,
    humanMessageTitle,
    parseContextMessageDirective,
    type ContextMessageStatus,
    type MessageEntry,
    type MessagePreferencesSnapshot,
} from "@portable-devshell/shared";

import { tuiMessagesHistoryRows } from "../../../../terminal/Public.js";

export { tuiMessagesHistoryRows } from "../../../../terminal/Layout.js";

import { workspaceFolderName } from "../../../presentation/Workspace.js";

import type { TuiAppState } from "../../../../state/store/Model.js";
import { currentTuiRoute } from "../../../../state/route/State.js";
import {
    nextTuiGraphemeCursor,
    normalizeTuiGraphemeCursor,
} from "../../../../interaction/selection/Model.js";
import type { TuiSidebarContextEntry } from "../../../../state/Ui.js";
import { wrapTerminalText } from "../../../../terminal/Public.js";
import type { TuiDomainReader } from "../../../domain/Reader.js";

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
const emptyMessageEntries = Object.freeze(
    [],
) as readonly MessageEntry[];
const messageHistoryCache = new WeakMap<
    readonly MessageEntry[],
    Map<string, Array<{ kind: "meta" | "text"; text: string }>>
>();
let messageSessionCache:
    | {
          contexts: TuiDomainReader["context"]["contexts"];
          messageHistoryInstances: TuiDomainReader["messageHistory"]["instances"];
          messagesInstances: TuiDomainReader["messages"]["instances"];
          instances: TuiDomainReader["instances"]["instances"];
          preferences: MessagePreferencesSnapshot;
          sessions: TuiMessageSession[];
      }
    | undefined;

export function selectTuiMessageSessions(
    reader: TuiDomainReader,
    now: number = Date.now(),
): TuiMessageSession[] {
    return projectTuiMessageSessions(reader).filter(
        (session) =>
            reader.messagePreferences.preferences.hiddenContexts[session.ctxId] !==
                true && isActiveMessageSession(session, now),
    );
}

export function selectTuiMessageHistorySessions(
    reader: TuiDomainReader,
    now: number = Date.now(),
): TuiMessageSession[] {
    return projectTuiMessageSessions(reader).filter(
        (session) =>
            reader.messagePreferences.preferences.hiddenContexts[session.ctxId] !==
                true && !isActiveMessageSession(session, now),
    );
}

export function selectTuiMessageHiddenSessions(
    reader: TuiDomainReader,
): TuiMessageSession[] {
    return projectTuiMessageSessions(reader).filter(
        (session) =>
            reader.messagePreferences.preferences.hiddenContexts[session.ctxId] ===
            true,
    );
}

function projectTuiMessageSessions(
    reader: TuiDomainReader,
): TuiMessageSession[] {
    const contexts = reader.context.contexts;
    const messageHistoryInstances = reader.messageHistory.instances;
    const messagesInstances = reader.messages.instances;
    const instances = reader.instances.instances;
    const preferences = reader.messagePreferences.preferences;
    const cached = messageSessionCache;
    if (
        cached !== undefined &&
        cached.contexts === contexts &&
        cached.messageHistoryInstances === messageHistoryInstances &&
        cached.messagesInstances === messagesInstances &&
        cached.instances === instances &&
        cached.preferences === preferences
    )
        return cached.sessions;
    const sessions = new Map<string, Omit<TuiMessageSession, "title">>();
    const summaries = new Map<string, { at: string; text: string }>();
    const touch = (
        instance: string,
        ctxId: string | undefined,
        input: Partial<Omit<TuiMessageSession, "ctxId" | "instance" | "title">>,
    ) => {
        if (ctxId === undefined || ctxId.length === 0) return;
        const key = messageKey(instance, ctxId);
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

    for (const context of contexts) {
        for (const environment of context.environments) {
            touch(environment.instance, context.ctxId, {
                latestAt: context.lastAccessedAt || context.createdAt,
                startedAt: context.createdAt,
                status: context.status,
                workspace: environment.workspace,
            });
        }
    }
    for (const { name } of instances) {
        for (const entry of messageHistoryInstances[name]?.entries ?? []) {
            touch(name, entry.ctxId, {
                latestAt: entry.createdAt,
                startedAt: entry.createdAt,
            });
            if (entry.kind !== "comment") continue;
            const text = messageSummary(entry.text);
            if (text === undefined) continue;
            const key = messageKey(name, entry.ctxId);
            const current = summaries.get(key);
            if (
                current === undefined ||
                entry.createdAt.localeCompare(current.at) < 0
            ) {
                summaries.set(key, { at: entry.createdAt, text });
            }
        }
        for (const message of messagesInstances[name]?.messages ?? []) {
            touch(name, message.ctxId, {
                latestAt: message.createdAt,
                startedAt: message.createdAt,
            });
        }
    }

    const values = [...sessions.values()];
    const baseTitles = values.map(
        (session) =>
            preferences.titles[messageKey(session.instance, session.ctxId)] ??
            summaries.get(messageKey(session.instance, session.ctxId))
                ?.text ??
            humanMessageTitle(session),
    );
    const titleCounts = new Map<string, number>();
    for (const title of baseTitles) {
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }
    const projected = values
        .map((session, index): TuiMessageSession => {
            const baseTitle =
                baseTitles[index] ?? humanMessageTitle(session);
            return {
                ...session,
                title:
                    (titleCounts.get(baseTitle) ?? 0) > 1
                        ? `${baseTitle} · ${compactContextId(session.ctxId, 8)}`
                        : baseTitle,
            };
        })
        .sort((left, right) => compareMessageSessions(preferences, left, right));
    messageSessionCache = {
        contexts,
        messageHistoryInstances,
        messagesInstances,
        instances,
        preferences,
        sessions: projected,
    };
    return projected;
}

export function selectTuiMessagesSidebarEntries(
    state: TuiAppState,
    reader: TuiDomainReader,
    focused: boolean,
    cursor: TuiAppState["interaction"]["sidebarCursor"],
    now: number = Date.now(),
): TuiSidebarContextEntry[] {
    const route = currentTuiRoute(state);
    const scope = state.ui.messageScope;
    const allSessions = projectTuiMessageSessions(reader);
    const hiddenContexts = reader.messagePreferences.preferences.hiddenContexts;
    const scopedSessions =
        scope === "active"
            ? allSessions.filter(
                  (session) =>
                      hiddenContexts[session.ctxId] !== true &&
                      isActiveMessageSession(session, now),
              )
            : scope === "history"
              ? allSessions.filter(
                    (session) =>
                        hiddenContexts[session.ctxId] !== true &&
                        !isActiveMessageSession(session, now),
                )
              : allSessions.filter(
                    (session) => hiddenContexts[session.ctxId] === true,
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
                        kind: "messageSession",
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
    preferences: MessagePreferencesSnapshot,
    left: TuiMessageSession,
    right: TuiMessageSession,
): number {
    const leftWorkspace = workspacePreferenceKey(left);
    const rightWorkspace = workspacePreferenceKey(right);
    const workspaceRank = new Map(
        preferences.workspaceOrder.map((key, index) => [key, index]),
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
    const order = preferences.orderByWorkspace[leftWorkspace] ?? [];
    const leftRank = order.indexOf(messageKey(left.instance, left.ctxId));
    const rightRank = order.indexOf(
        messageKey(right.instance, right.ctxId),
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

function messageKey(instance: string, ctxId: string): string {
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
    reader: TuiDomainReader,
    instance: string,
    ctxId: string,
): TuiMessageEntry[] {
    return selectTuiMessageEntriesFromSource(
        reader.messageHistory.instances[instance]?.entries ??
            emptyMessageEntries,
        ctxId,
    );
}

function selectTuiMessageEntriesFromSource(
    entries: readonly MessageEntry[],
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
    reader: TuiDomainReader,
    instance: string,
    ctxId: string,
    width: number,
): Array<{ kind: "meta" | "text"; text: string }> {
    const innerWidth = Math.max(1, width - 2);
    const source =
        reader.messageHistory.instances[instance]?.entries ??
        emptyMessageEntries;
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

function messageSummary(text: string): string | undefined {
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
