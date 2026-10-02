/**
 * Conversation model.
 *
 * Owns Conversation entries (comments and reports), Conversation preferences,
 * and the identity semantics shared by every interaction surface. The
 * Conversation surface is authoritative for Comment records; it borrows only
 * the message delivery-status type for comment status, so the dependency on the
 * message domain is one-way.
 */

import type { InstanceEvent } from "../../runtime/activity/Model.js";
import type { ContextMessageStatus } from "../message/Model.js";

export type ConversationEntryKind = "comment" | "report";

export interface ConversationEntry {
    callId?: string;
    createdAt: string;
    ctxId: string;
    deliveredAt?: string;
    error?: string;
    failedAt?: string;
    id: string;
    kind: ConversationEntryKind;
    status?: ContextMessageStatus;
    text: string;
}

export interface ConversationListInput {
    before?: string;
    ctxId?: string;
    limit?: number;
    maxBytes?: number;
}

export interface ConversationListResult {
    entries: ConversationEntry[];
    /** Instance event sequence at read time. Subscribe from lastSeq + 1. */
    lastSeq: number;
}

export const CONVERSATION_PREFERENCES_VERSION = 1 as const;

export interface ConversationPreferencesSnapshot {
    hiddenContexts: Record<string, true>;
    orderByWorkspace: Record<string, string[]>;
    titles: Record<string, string>;
    version: typeof CONVERSATION_PREFERENCES_VERSION;
    workspaceOrder: string[];
}

export interface ConversationPreferencesPatch {
    hiddenContexts?: Record<string, true | null>;
    ifMissing?: boolean;
    orderByWorkspace?: Record<string, string[]>;
    titles?: Record<string, string | null>;
    workspaceOrder?: string[];
}

export function createEmptyConversationPreferences(): ConversationPreferencesSnapshot {
    return {
        hiddenContexts: {},
        orderByWorkspace: {},
        titles: {},
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder: [],
    };
}

const MAX_PREFERENCE_KEYS = 10_000;
const MAX_PREFERENCE_KEY_LENGTH = 8_192;
const MAX_CONVERSATION_TITLE_LENGTH = 120;

export function parseConversationPreferencesPatch(
    value: unknown,
): ConversationPreferencesPatch {
    const record = requireRecord(value, "Conversation preferences patch");
    rejectUnknownKeys(record, [
        "hiddenContexts",
        "ifMissing",
        "orderByWorkspace",
        "titles",
        "workspaceOrder",
    ]);
    if (record.ifMissing !== undefined && typeof record.ifMissing !== "boolean")
        throw new TypeError(
            "Conversation preferences ifMissing must be a boolean.",
        );
    return {
        ...(record.hiddenContexts === undefined
            ? {}
            : {
                  hiddenContexts: parseHiddenContexts(
                      record.hiddenContexts,
                      true,
                  ),
              }),
        ...(record.ifMissing === undefined
            ? {}
            : { ifMissing: record.ifMissing }),
        ...(record.orderByWorkspace === undefined
            ? {}
            : {
                  orderByWorkspace: parseOrderByWorkspace(
                      record.orderByWorkspace,
                  ),
              }),
        ...(record.titles === undefined
            ? {}
            : { titles: parseTitles(record.titles, true) }),
        ...(record.workspaceOrder === undefined
            ? {}
            : {
                  workspaceOrder: parseStringList(
                      record.workspaceOrder,
                      "workspaceOrder",
                  ),
              }),
    };
}

export function parseConversationPreferencesSnapshot(
    value: unknown,
): ConversationPreferencesSnapshot {
    const record = requireRecord(value, "Conversation preferences");
    rejectUnknownKeys(record, [
        "hiddenContexts",
        "orderByWorkspace",
        "titles",
        "version",
        "workspaceOrder",
    ]);
    if (record.version !== CONVERSATION_PREFERENCES_VERSION)
        throw new TypeError(
            `Unsupported Conversation preferences version: ${String(record.version)}.`,
        );
    return {
        hiddenContexts:
            record.hiddenContexts === undefined
                ? {}
                : (parseHiddenContexts(record.hiddenContexts, false) as Record<
                      string,
                      true
                  >),
        orderByWorkspace: parseOrderByWorkspace(record.orderByWorkspace),
        titles: parseTitles(record.titles, false) as Record<string, string>,
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder: parseStringList(record.workspaceOrder, "workspaceOrder"),
    };
}

export function applyConversationPreferencesPatch(
    current: ConversationPreferencesSnapshot,
    patch: ConversationPreferencesPatch,
): ConversationPreferencesSnapshot {
    const missingOnly = patch.ifMissing === true;
    const hiddenContexts = { ...current.hiddenContexts };
    for (const [ctxId, hidden] of Object.entries(patch.hiddenContexts ?? {})) {
        if (missingOnly && Object.hasOwn(current.hiddenContexts, ctxId))
            continue;
        if (hidden === null) delete hiddenContexts[ctxId];
        else hiddenContexts[ctxId] = true;
    }
    const titles = { ...current.titles };
    for (const [key, title] of Object.entries(patch.titles ?? {})) {
        if (missingOnly && Object.hasOwn(current.titles, key)) continue;
        if (title === null) delete titles[key];
        else titles[key] = title;
    }
    const orderByWorkspace = { ...current.orderByWorkspace };
    for (const [workspace, order] of Object.entries(
        patch.orderByWorkspace ?? {},
    )) {
        const existing = current.orderByWorkspace[workspace];
        orderByWorkspace[workspace] =
            missingOnly && existing !== undefined
                ? [...order.filter((key) => !existing.includes(key)), ...existing]
                : [...order];
    }
    const workspaceOrder =
        patch.workspaceOrder === undefined
            ? [...current.workspaceOrder]
            : missingOnly
              ? [
                    ...current.workspaceOrder,
                    ...patch.workspaceOrder.filter(
                        (workspace) =>
                            !current.workspaceOrder.includes(workspace),
                    ),
                ]
              : [...patch.workspaceOrder];
    return {
        hiddenContexts,
        orderByWorkspace,
        titles,
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder,
    };
}

export function cloneConversationPreferences(
    value: ConversationPreferencesSnapshot,
): ConversationPreferencesSnapshot {
    return {
        hiddenContexts: { ...value.hiddenContexts },
        orderByWorkspace: Object.fromEntries(
            Object.entries(value.orderByWorkspace).map(([key, order]) => [
                key,
                [...order],
            ]),
        ),
        titles: { ...value.titles },
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder: [...value.workspaceOrder],
    };
}

export function sameConversationPreferences(
    left: ConversationPreferencesSnapshot,
    right: ConversationPreferencesSnapshot,
): boolean {
    return (
        sameStringList(left.workspaceOrder, right.workspaceOrder) &&
        sameRecord(left.hiddenContexts, right.hiddenContexts) &&
        sameRecord(left.titles, right.titles) &&
        sameOrderByWorkspace(left.orderByWorkspace, right.orderByWorkspace)
    );
}

/**
 * Conversation identity semantics shared by every interaction surface. These
 * are domain rules (prefer the workspace folder over an opaque Context id), not
 * UI formatting such as relative time.
 */
export function compactContextId(ctxId: string, prefixLength = 12): string {
    return ctxId.length <= prefixLength + 4
        ? ctxId
        : `${ctxId.slice(0, prefixLength)}…`;
}

export function humanConversationTitle(
    input: {
        ctxId: string;
        workspace?: string;
    },
    contextPrefixLength = 12,
): string {
    return input.workspace === undefined || input.workspace.length === 0
        ? compactContextId(input.ctxId, contextPrefixLength)
        : workspaceFolderName(input.workspace);
}

/**
 * Conversation projection. Merges a freshly observed Conversation entry,
 * keeping the newest identity while preserving messages that are still in
 * flight (`pending`/`sent`) when a server list no longer reports them.
 */
export function mergeConversationEntry(
    current: readonly ConversationEntry[],
    incoming: ConversationEntry,
): ConversationEntry[] {
    return [
        ...current.filter(
            (entry) =>
                !(entry.kind === incoming.kind && entry.id === incoming.id),
        ),
        incoming,
    ].sort(
        (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
    );
}

export function mergeConversationEntryList(
    current: readonly ConversationEntry[],
    incoming: readonly ConversationEntry[],
): ConversationEntry[] {
    let result = [...current];
    for (const entry of incoming)
        result = mergeConversationEntry(result, entry);
    const incomingKeys = new Set(
        incoming.map((entry) => `${entry.kind}:${entry.id}`),
    );
    return result.filter(
        (entry) =>
            incomingKeys.has(`${entry.kind}:${entry.id}`) ||
            (entry.kind === "comment" &&
                (entry.status === "pending" || entry.status === "sent")),
    );
}

/** Instance activity events that change the Conversation projection. */
export function isConversationEvent(event: InstanceEvent): boolean {
    if (event.type.startsWith("context.message.")) return true;
    return (
        event.type === "toolCall.completed" &&
        isRecord(event.data) &&
        event.data.toolName === "todo_report"
    );
}

function parseHiddenContexts(
    value: unknown,
    allowNull: boolean,
): Record<string, true | null> {
    const record = requireRecord(
        value,
        "Conversation preferences hiddenContexts",
    );
    const entries = Object.entries(record);
    if (entries.length > MAX_PREFERENCE_KEYS)
        throw new TypeError(
            "Conversation preferences contains too many hidden Contexts.",
        );
    return Object.fromEntries(
        entries.map(([ctxId, hidden]) => {
            validatePreferenceKey(ctxId, "Context id");
            if (allowNull && hidden === null) return [ctxId, null];
            if (hidden !== true)
                throw new TypeError(
                    "Conversation hidden Context values must be true or null.",
                );
            return [ctxId, true];
        }),
    );
}

function parseOrderByWorkspace(value: unknown): Record<string, string[]> {
    const record = requireRecord(
        value,
        "Conversation preferences orderByWorkspace",
    );
    const entries = Object.entries(record);
    if (entries.length > MAX_PREFERENCE_KEYS)
        throw new TypeError(
            "Conversation preferences contains too many workspaces.",
        );
    return Object.fromEntries(
        entries.map(([workspace, order]) => {
            validatePreferenceKey(workspace, "workspace");
            return [
                workspace,
                parseStringList(order, `orderByWorkspace.${workspace}`),
            ];
        }),
    );
}

function parseTitles(
    value: unknown,
    allowNull: boolean,
): Record<string, string | null> {
    const record = requireRecord(value, "Conversation preferences titles");
    const entries = Object.entries(record);
    if (entries.length > MAX_PREFERENCE_KEYS)
        throw new TypeError(
            "Conversation preferences contains too many titles.",
        );
    return Object.fromEntries(
        entries.map(([key, title]) => {
            validatePreferenceKey(key, "conversation key");
            if (allowNull && title === null) return [key, null];
            if (
                typeof title !== "string" ||
                title.length < 1 ||
                title.length > MAX_CONVERSATION_TITLE_LENGTH
            )
                throw new TypeError(
                    `Conversation title must contain 1-${MAX_CONVERSATION_TITLE_LENGTH} characters.`,
                );
            return [key, title];
        }),
    );
}

function parseStringList(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > MAX_PREFERENCE_KEYS)
        throw new TypeError(
            `Conversation preferences ${label} must be an array with at most ${MAX_PREFERENCE_KEYS} items.`,
        );
    const output: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string")
            throw new TypeError(
                `Conversation preferences ${label} items must be strings.`,
            );
        validatePreferenceKey(item, label);
        if (!seen.has(item)) {
            seen.add(item);
            output.push(item);
        }
    }
    return output;
}

function validatePreferenceKey(value: string, label: string): void {
    if (value.length < 1 || value.length > MAX_PREFERENCE_KEY_LENGTH)
        throw new TypeError(
            `Conversation preferences ${label} must contain 1-${MAX_PREFERENCE_KEY_LENGTH} characters.`,
        );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TypeError(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

function rejectUnknownKeys(
    record: Record<string, unknown>,
    allowed: readonly string[],
): void {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
    if (unknown !== undefined)
        throw new TypeError(
            `Unknown Conversation preferences field: ${unknown}.`,
        );
}

function sameRecord(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
): boolean {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every(
        (key) => Object.hasOwn(right, key) && left[key] === right[key],
    );
}

function sameOrderByWorkspace(
    left: Record<string, string[]>,
    right: Record<string, string[]>,
): boolean {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => {
        const order = right[key];
        return order !== undefined && sameStringList(left[key]!, order);
    });
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

function workspaceFolderName(workspace: string): string {
    const normalized = workspace.replace(/[\\/]+$/u, "");
    if (normalized.length === 0) return workspace;
    return normalized.split(/[\\/]/u).at(-1) || workspace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}