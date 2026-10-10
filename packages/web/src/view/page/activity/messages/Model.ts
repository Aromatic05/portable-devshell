import {
    compactContextId,
    humanMessageTitle,
    parseContextMessageDirective,
    type ContextMessageStatus,
    type MessageEntry,
    type MessagePreferencesPatch,
    type MessagePreferencesSnapshot,
    type MessageHistoryViewModelState,
    type InstanceListEntry,
    type ContextRecord,
    type MessageViewModelState,
} from "@portable-devshell/shared";

import { workspaceFolderName } from "../../../Presentation.js";

export interface WebMessageEntry {
    at: string;
    id: string;
    kind: "comment" | "report";
    status?: ContextMessageStatus;
    text: string;
}

export interface WebMessageSession {
    ctxId: string;
    instance: string;
    latestAt: string;
    startedAt: string;
    status?: "active" | "expired" | "disabled";
    title: string;
    workspace?: string;
}

const activeSessionWindowMs = 30 * 60 * 1_000;
const emptyMessageEntries = Object.freeze(
    [],
) as readonly MessageEntry[];

/**
 * Explicit domain state used to project Message sessions. Keeping the
 * inputs as plain values lets the model stay pure without reaching into a
 * WebState or a shared read-model snapshot.
 */
export interface WebMessageProjection {
    contexts: readonly ContextRecord[];
    message: MessageHistoryViewModelState;
    instances: readonly InstanceListEntry[];
    messages: MessageViewModelState;
}

export function selectWebMessageSessions(
    input: WebMessageProjection,
    now: number = Date.now(),
): WebMessageSession[] {
    return projectWebMessageSessions(input).filter((session) =>
        isWebMessageSessionActive(session, now),
    );
}

export function selectWebMessageHistorySessions(
    input: WebMessageProjection,
    now: number = Date.now(),
): WebMessageSession[] {
    return projectWebMessageSessions(input).filter(
        (session) => !isWebMessageSessionActive(session, now),
    );
}

export function selectWebMessageSession(
    input: WebMessageProjection,
    instance: string,
    ctxId: string,
): WebMessageSession | undefined {
    return projectWebMessageSessions(input).find(
        (session) => session.instance === instance && session.ctxId === ctxId,
    );
}

function projectWebMessageSessions(
    input: WebMessageProjection,
): WebMessageSession[] {
    const sessions = new Map<string, Omit<WebMessageSession, "title">>();
    const summaries = new Map<string, { at: string; text: string }>();
    const touch = (
        instance: string,
        ctxId: string | undefined,
        patch: Partial<Omit<WebMessageSession, "ctxId" | "instance" | "title">>,
    ) => {
        if (ctxId === undefined || ctxId.length === 0) return;
        const key = `${instance}\u0000${ctxId}`;
        const current = sessions.get(key);
        sessions.set(key, {
            ctxId,
            instance,
            latestAt: laterTimestamp(current?.latestAt, patch.latestAt),
            startedAt: earlierTimestamp(current?.startedAt, patch.startedAt),
            status: patch.status ?? current?.status,
            workspace: patch.workspace ?? current?.workspace,
        });
    };

    for (const context of input.contexts) {
        for (const environment of context.environments) {
            touch(environment.instance, context.ctxId, {
                latestAt: context.lastAccessedAt || context.createdAt,
                startedAt: context.createdAt,
                status: context.status,
                workspace: environment.workspace,
            });
        }
    }
    for (const { name } of input.instances) {
        for (const entry of input.message.instances[name]?.entries ?? []) {
            touch(name, entry.ctxId, {
                latestAt: entry.createdAt,
                startedAt: entry.createdAt,
            });
            if (entry.kind !== "comment") continue;
            const text = messageSummary(entry.text);
            if (text === undefined) continue;
            const key = `${name}\u0000${entry.ctxId}`;
            const current = summaries.get(key);
            if (
                current === undefined ||
                entry.createdAt.localeCompare(current.at) < 0
            ) {
                summaries.set(key, { at: entry.createdAt, text });
            }
        }
        for (const message of input.messages.instances[name]?.messages ?? []) {
            touch(name, message.ctxId, {
                latestAt: message.createdAt,
                startedAt: message.createdAt,
            });
        }
    }

    const values = [...sessions.values()];
    const baseTitles = values.map(
        (session) =>
            summaries.get(`${session.instance}\u0000${session.ctxId}`)?.text ??
            humanMessageTitle(session),
    );
    const titleCounts = new Map<string, number>();
    for (const title of baseTitles)
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    return values
        .map((session, index): WebMessageSession => {
            const baseTitle =
                baseTitles[index] ?? humanMessageTitle(session);
            return {
                ...session,
                title:
                    (titleCounts.get(baseTitle) ?? 0) > 1
                        ? `${baseTitle} · ${compactContextId(session.ctxId, 10)}`
                        : baseTitle,
            };
        })
        .sort(
            (left, right) =>
                right.startedAt.localeCompare(left.startedAt) ||
                left.ctxId.localeCompare(right.ctxId),
        );
}

export function selectWebMessageEntries(
    input: WebMessageProjection,
    instance: string,
    ctxId: string,
): WebMessageEntry[] {
    const source =
        input.message.instances[instance]?.entries ??
        emptyMessageEntries;
    return source
        .filter((entry) => entry.ctxId === ctxId)
        .map((entry): WebMessageEntry => ({
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

export function filterWebMessageSessions(
    sessions: readonly WebMessageSession[],
    query: string,
): WebMessageSession[] {
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

function isWebMessageSessionActive(
    session: WebMessageSession,
    now: number,
): boolean {
    return Date.parse(session.latestAt) >= now - activeSessionWindowMs;
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

export function groupMessageSessionsByWorkspace(
    sessions: readonly WebMessageSession[],
): Array<{
    key: string;
    label: string;
    sessions: WebMessageSession[];
    workspace?: string;
}> {
    const groups = new Map<
        string,
        {
            key: string;
            label: string;
            sessions: WebMessageSession[];
            workspace?: string;
        }
    >();
    for (const session of sessions) {
        const key = workspacePreferenceKey(session);
        const group = groups.get(key) ?? {
            key,
            label:
                session.workspace === undefined
                    ? session.instance
                    : workspaceFolderName(session.workspace),
            sessions: [],
            ...(session.workspace === undefined
                ? {}
                : { workspace: session.workspace }),
        };
        group.sessions.push(session);
        groups.set(key, group);
    }
    return [...groups.values()];
}

export function isMessageHidden(
    preferences: MessagePreferencesSnapshot,
    session: Pick<WebMessageSession, "ctxId">,
): boolean {
    return preferences.hiddenContexts?.[session.ctxId] === true;
}

export function messageKey(
    session: Pick<WebMessageSession, "ctxId" | "instance">,
): string {
    return `${session.instance}\u0000${session.ctxId}`;
}

export function workspacePreferenceKey(
    session: Pick<WebMessageSession, "instance" | "workspace">,
): string {
    return session.workspace ?? `\u0000${session.instance}`;
}

export function applyMessagePreferences(
    sessions: readonly WebMessageSession[],
    preferences: MessagePreferencesSnapshot,
): WebMessageSession[] {
    const workspaceRank = new Map(
        preferences.workspaceOrder.map((key, index) => [key, index]),
    );
    const messageRanks = new Map(
        Object.entries(preferences.orderByWorkspace).map(([workspace, order]) => [
            workspace,
            new Map(order.map((key, index) => [key, index])),
        ]),
    );
    return sessions
        .map((session) => ({
            ...session,
            title:
                preferences.titles[messageKey(session)] ?? session.title,
        }))
        .sort((left, right) => {
            const leftWorkspace = workspacePreferenceKey(left);
            const rightWorkspace = workspacePreferenceKey(right);
            if (leftWorkspace !== rightWorkspace) {
                const leftWorkspaceRank = workspaceRank.get(leftWorkspace);
                const rightWorkspaceRank = workspaceRank.get(rightWorkspace);
                if (
                    leftWorkspaceRank !== undefined ||
                    rightWorkspaceRank !== undefined
                ) {
                    if (leftWorkspaceRank === undefined) return 1;
                    if (rightWorkspaceRank === undefined) return -1;
                    return leftWorkspaceRank - rightWorkspaceRank;
                }
                return leftWorkspace.localeCompare(rightWorkspace);
            }
            const rank = messageRanks.get(leftWorkspace);
            const leftRank = rank?.get(messageKey(left));
            const rightRank = rank?.get(messageKey(right));
            if (leftRank === undefined && rightRank === undefined)
                return (
                    right.startedAt.localeCompare(left.startedAt) ||
                    left.ctxId.localeCompare(right.ctxId)
                );
            if (leftRank === undefined) return -1;
            if (rightRank === undefined) return 1;
            return leftRank - rightRank;
        });
}

export function ensureMessagePreferenceOrder(
    preferences: MessagePreferencesSnapshot,
    sessions: readonly WebMessageSession[],
): MessagePreferencesSnapshot {
    const workspaceSessions = new Map<string, WebMessageSession[]>();
    for (const session of sessions) {
        const workspace = workspacePreferenceKey(session);
        const current = workspaceSessions.get(workspace) ?? [];
        current.push(session);
        workspaceSessions.set(workspace, current);
    }
    const loadedWorkspaces = [...workspaceSessions.keys()];
    const workspaceOrder = [
        ...preferences.workspaceOrder,
        ...loadedWorkspaces.filter(
            (workspace) => !preferences.workspaceOrder.includes(workspace),
        ),
    ];
    const orderByWorkspace = { ...preferences.orderByWorkspace };
    let changed =
        workspaceOrder.length !== preferences.workspaceOrder.length ||
        workspaceOrder.some(
            (workspace, index) =>
                workspace !== preferences.workspaceOrder[index],
        );
    for (const [workspace, values] of workspaceSessions) {
        const loadedKeys = values.map(messageKey);
        const previous = orderByWorkspace[workspace] ?? [];
        const previousKeys = new Set(previous);
        const missing = loadedKeys.filter((key) => !previousKeys.has(key));
        const next = [...missing, ...previous];
        if (
            orderByWorkspace[workspace] === undefined ||
            next.length !== orderByWorkspace[workspace]!.length ||
            next.some(
                (key, index) => key !== orderByWorkspace[workspace]![index],
            )
        ) {
            orderByWorkspace[workspace] = next;
            changed = true;
        }
    }
    if (!changed) return preferences;
    return { ...preferences, orderByWorkspace, workspaceOrder };
}

export function messageOrderPatch(
    current: MessagePreferencesSnapshot,
    next: MessagePreferencesSnapshot,
): MessagePreferencesPatch | undefined {
    const orderByWorkspace = Object.fromEntries(
        Object.entries(next.orderByWorkspace).filter(([workspace, order]) => {
            const previous = current.orderByWorkspace[workspace];
            return (
                previous === undefined ||
                previous.length !== order.length ||
                order.some((key, index) => key !== previous[index])
            );
        }),
    );
    const workspaceOrderChanged =
        current.workspaceOrder.length !== next.workspaceOrder.length ||
        next.workspaceOrder.some(
            (workspace, index) => workspace !== current.workspaceOrder[index],
        );
    if (Object.keys(orderByWorkspace).length === 0 && !workspaceOrderChanged)
        return undefined;
    return {
        ...(Object.keys(orderByWorkspace).length === 0
            ? {}
            : { orderByWorkspace }),
        ...(workspaceOrderChanged
            ? { workspaceOrder: next.workspaceOrder }
            : {}),
    };
}

export function reorderMessageKeys(
    sessions: readonly WebMessageSession[],
    sourceKey: string,
    targetKey: string,
    previousOrder: readonly string[],
): string[] {
    const keys = sessions.map(messageKey);
    const sourceIndex = keys.indexOf(sourceKey);
    const targetIndex = keys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex)
        return [...previousOrder];
    const [moved] = keys.splice(sourceIndex, 1);
    if (moved === undefined) return [...previousOrder];
    keys.splice(targetIndex, 0, moved);
    const loaded = new Set(keys);
    return [...keys, ...previousOrder.filter((key) => !loaded.has(key))];
}
