import {
    compactContextId,
    humanConversationTitle,
    parseContextMessageDirective,
    workspaceFolderName,
    type ContextMessageStatus,
    type ConversationEntry,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
} from "@portable-devshell/shared/browser";

import type { WebState } from "../../../../state/Model.js";

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
const emptyConversationEntries = Object.freeze(
    [],
) as readonly ConversationEntry[];
const messageEntryCache = new WeakMap<
    readonly ConversationEntry[],
    Map<string, WebMessageEntry[]>
>();
let messageSessionCache:
    | {
          contexts: WebState["readModel"]["contexts"];
          instanceState: WebState["readModel"]["instanceState"];
          sessions: WebMessageSession[];
      }
    | undefined;

export function selectWebMessageSessions(
    state: WebState,
    now: number = Date.now(),
): WebMessageSession[] {
    return projectWebMessageSessions(state).filter((session) =>
        isWebMessageSessionActive(session, now),
    );
}

export function selectWebMessageHistorySessions(
    state: WebState,
    now: number = Date.now(),
): WebMessageSession[] {
    return projectWebMessageSessions(state).filter(
        (session) => !isWebMessageSessionActive(session, now),
    );
}

export function selectWebMessageSession(
    state: WebState,
    instance: string,
    ctxId: string,
): WebMessageSession | undefined {
    return projectWebMessageSessions(state).find(
        (session) => session.instance === instance && session.ctxId === ctxId,
    );
}

function projectWebMessageSessions(state: WebState): WebMessageSession[] {
    if (
        messageSessionCache?.contexts === state.readModel.contexts &&
        messageSessionCache.instanceState === state.readModel.instanceState
    )
        return messageSessionCache.sessions;
    const sessions = new Map<string, Omit<WebMessageSession, "title">>();
    const summaries = new Map<string, { at: string; text: string }>();
    const touch = (
        instance: string,
        ctxId: string | undefined,
        input: Partial<Omit<WebMessageSession, "ctxId" | "instance" | "title">>,
    ) => {
        if (ctxId === undefined || ctxId.length === 0) return;
        const key = `${instance}\u0000${ctxId}`;
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
            {
                instance: context.instance,
                workspace: context.workspace,
            },
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
            const key = `${instance}\u0000${entry.ctxId}`;
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
    const baseTitles = values.map(
        (session) =>
            summaries.get(`${session.instance}\u0000${session.ctxId}`)?.text ??
            humanConversationTitle(session),
    );
    const titleCounts = new Map<string, number>();
    for (const title of baseTitles)
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    const projected = values
        .map((session, index): WebMessageSession => {
            const baseTitle =
                baseTitles[index] ?? humanConversationTitle(session);
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
    messageSessionCache = {
        contexts: state.readModel.contexts,
        instanceState: state.readModel.instanceState,
        sessions: projected,
    };
    return projected;
}

export function selectWebMessageEntries(
    state: WebState,
    instance: string,
    ctxId: string,
): WebMessageEntry[] {
    const source =
        state.readModel.instanceState[instance]?.conversationEntries ??
        emptyConversationEntries;
    let byContext = messageEntryCache.get(source);
    if (byContext === undefined) {
        byContext = new Map();
        messageEntryCache.set(source, byContext);
    }
    const cached = byContext.get(ctxId);
    if (cached !== undefined) return cached;
    const projected = source
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
    byContext.set(ctxId, projected);
    return projected;
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

function conversationSummary(text: string): string | undefined {
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

export function isConversationHidden(
    preferences: ConversationPreferencesSnapshot,
    session: Pick<WebMessageSession, "ctxId">,
): boolean {
    return preferences.hiddenContexts?.[session.ctxId] === true;
}

export interface LegacyConversationPreferences {
    legacyOrder: string[];
    preferences: ConversationPreferencesSnapshot;
}

const conversationPreferencesStorageKey =
    "portable-devshell:web:conversation-preferences:v1";

export function conversationKey(
    session: Pick<WebMessageSession, "ctxId" | "instance">,
): string {
    return `${session.instance}\u0000${session.ctxId}`;
}

export function workspacePreferenceKey(
    session: Pick<WebMessageSession, "instance" | "workspace">,
): string {
    return session.workspace ?? `\u0000${session.instance}`;
}

/**
 * @compat web-conversation-preferences-v1
 * @removeAt 0.7.10
 */
export function readLegacyConversationPreferences():
    LegacyConversationPreferences | undefined {
    if (typeof window === "undefined") return undefined;
    try {
        const raw = window.localStorage.getItem(
            conversationPreferencesStorageKey,
        );
        if (raw === null) return undefined;
        const parsed = JSON.parse(raw) as {
            order?: unknown;
            orderByWorkspace?: unknown;
            titles?: unknown;
            workspaceOrder?: unknown;
        };
        const legacyOrder = Array.isArray(parsed.order)
            ? parsed.order.filter(
                  (value): value is string => typeof value === "string",
              )
            : [];
        const orderByWorkspace =
            typeof parsed.orderByWorkspace === "object" &&
            parsed.orderByWorkspace !== null &&
            !Array.isArray(parsed.orderByWorkspace)
                ? Object.fromEntries(
                      Object.entries(parsed.orderByWorkspace).flatMap(
                          ([workspace, value]) =>
                              Array.isArray(value)
                                  ? [
                                        [
                                            workspace,
                                            value.filter(
                                                (item): item is string =>
                                                    typeof item === "string",
                                            ),
                                        ],
                                    ]
                                  : [],
                      ),
                  )
                : {};
        const titles =
            typeof parsed.titles === "object" &&
            parsed.titles !== null &&
            !Array.isArray(parsed.titles)
                ? Object.fromEntries(
                      Object.entries(parsed.titles).filter(
                          (entry): entry is [string, string] =>
                              typeof entry[1] === "string",
                      ),
                  )
                : {};
        const workspaceOrder = Array.isArray(parsed.workspaceOrder)
            ? parsed.workspaceOrder.filter(
                  (value): value is string => typeof value === "string",
              )
            : [];
        return {
            legacyOrder,
            preferences: {
                hiddenContexts: {},
                orderByWorkspace,
                titles,
                version: 1,
                workspaceOrder,
            },
        };
    } catch {
        return undefined;
    }
}

export function removeLegacyConversationPreferences(): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(conversationPreferencesStorageKey);
    } catch {
        // Migration cleanup is best-effort after the server has accepted the preferences.
    }
}

export function applyConversationPreferences(
    sessions: readonly WebMessageSession[],
    preferences: ConversationPreferencesSnapshot,
): WebMessageSession[] {
    const workspaceRank = new Map(
        preferences.workspaceOrder.map((key, index) => [key, index]),
    );
    const conversationRanks = new Map(
        Object.entries(preferences.orderByWorkspace).map(([workspace, order]) => [
            workspace,
            new Map(order.map((key, index) => [key, index])),
        ]),
    );
    return sessions
        .map((session) => ({
            ...session,
            title:
                preferences.titles[conversationKey(session)] ?? session.title,
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
            const rank = conversationRanks.get(leftWorkspace);
            const leftRank = rank?.get(conversationKey(left));
            const rightRank = rank?.get(conversationKey(right));
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

export function ensureConversationPreferenceOrder(
    preferences: ConversationPreferencesSnapshot,
    sessions: readonly WebMessageSession[],
    legacyOrder: readonly string[] = [],
): ConversationPreferencesSnapshot {
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
        const loadedKeys = values.map(conversationKey);
        const loaded = new Set(loadedKeys);
        const previous =
            orderByWorkspace[workspace] ??
            legacyOrder.filter((key) => loaded.has(key));
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

export function conversationOrderPatch(
    current: ConversationPreferencesSnapshot,
    next: ConversationPreferencesSnapshot,
): ConversationPreferencesPatch | undefined {
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

export function reorderConversationKeys(
    sessions: readonly WebMessageSession[],
    sourceKey: string,
    targetKey: string,
    previousOrder: readonly string[],
): string[] {
    const keys = sessions.map(conversationKey);
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
