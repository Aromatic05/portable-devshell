import {
    humanConversationTitle,
    type ContextMessageStatus,
} from "@portable-devshell/shared/browser";

import type { WebState } from "../state/WebState.js";

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
    status?: "active" | "expired" | "disabled";
    title: string;
    workspace?: string;
}

const activeSessionWindowMs = 30 * 60 * 1_000;

export function selectWebMessageSessions(
    state: WebState,
    now: number = Date.now(),
): WebMessageSession[] {
    return projectWebMessageSessions(state).filter(
        (session) => isWebMessageSessionActive(session, now),
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
    const sessions = new Map<string, Omit<WebMessageSession, "title">>();
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
            status: input.status ?? current?.status,
            workspace: input.workspace ?? current?.workspace,
        });
    };

    for (const context of state.readModel.contexts) {
        const environments = context.environments ?? [{
            instance: context.instance,
            workspace: context.workspace,
        }];
        for (const environment of environments) {
            touch(environment.instance, context.ctxId, {
                latestAt: context.lastAccessedAt || context.createdAt,
                status: context.status,
                workspace: environment.workspace ?? context.workspace,
            });
        }
    }
    for (const [instance, instanceState] of Object.entries(state.readModel.instanceState)) {
        for (const entry of instanceState.conversationEntries) {
            touch(instance, entry.ctxId, { latestAt: entry.createdAt });
        }
    }

    const values = [...sessions.values()];
    const baseTitles = values.map((session) => humanConversationTitle(session));
    const titleCounts = new Map<string, number>();
    for (const title of baseTitles) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    return values
        .map((session, index): WebMessageSession => {
            const baseTitle = baseTitles[index] ?? humanConversationTitle(session);
            return {
                ...session,
                title: (titleCounts.get(baseTitle) ?? 0) > 1
                    ? `${baseTitle} · ${session.instance}`
                    : baseTitle,
            };
        })
        .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

export function selectWebMessageEntries(
    state: WebState,
    instance: string,
    ctxId: string,
): WebMessageEntry[] {
    const instanceState = state.readModel.instanceState[instance];
    if (instanceState === undefined) return [];
    return instanceState.conversationEntries
        .filter((entry) => entry.ctxId === ctxId)
        .map((entry): WebMessageEntry => ({
            at: entry.createdAt,
            id: `${entry.kind}:${entry.id}`,
            kind: entry.kind,
            ...(entry.status === undefined ? {} : { status: entry.status }),
            text: entry.text,
        }))
        .sort(
        (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );
}

export function filterWebMessageSessions(
    sessions: readonly WebMessageSession[],
    query: string,
): WebMessageSession[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [...sessions];
    return sessions.filter((session) => [
        session.title,
        session.ctxId,
        session.instance,
        session.workspace,
        session.status,
    ].some((value) => value?.toLowerCase().includes(needle) === true));
}

function isWebMessageSessionActive(session: WebMessageSession, now: number): boolean {
    return Date.parse(session.latestAt) >= now - activeSessionWindowMs;
}

function laterTimestamp(left: string | undefined, right: string | undefined): string {
    if (left === undefined) return right ?? "";
    if (right === undefined) return left;
    return left.localeCompare(right) >= 0 ? left : right;
}
