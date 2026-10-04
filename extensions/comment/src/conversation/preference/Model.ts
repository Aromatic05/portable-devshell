import type {
    ConversationPreferencesPatch,
    ConversationPreferencesSnapshot,
} from "@portable-devshell/shared";

export const CONVERSATION_PREFERENCES_VERSION = 1 as const;

const MAX_KEYS = 10_000;
const MAX_KEY_LENGTH = 8_192;
const MAX_TITLE_LENGTH = 120;

export function createEmptyConversationPreferences(): ConversationPreferencesSnapshot {
    return {
        hiddenContexts: {},
        orderByWorkspace: {},
        titles: {},
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder: [],
    };
}

export function parseConversationPreferencesPatch(
    value: unknown,
): ConversationPreferencesPatch {
    const record = object(value, "Conversation preferences patch");
    only(record, [
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
            : { hiddenContexts: hidden(record.hiddenContexts, true) }),
        ...(record.ifMissing === undefined
            ? {}
            : { ifMissing: record.ifMissing }),
        ...(record.orderByWorkspace === undefined
            ? {}
            : { orderByWorkspace: orders(record.orderByWorkspace) }),
        ...(record.titles === undefined
            ? {}
            : { titles: titles(record.titles, true) }),
        ...(record.workspaceOrder === undefined
            ? {}
            : { workspaceOrder: list(record.workspaceOrder, "workspaceOrder") }),
    };
}

export function parseConversationPreferencesSnapshot(
    value: unknown,
): ConversationPreferencesSnapshot {
    const record = object(value, "Conversation preferences");
    only(record, [
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
                : (hidden(record.hiddenContexts, false) as Record<string, true>),
        orderByWorkspace: orders(record.orderByWorkspace),
        titles: titles(record.titles, false) as Record<string, string>,
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder: list(record.workspaceOrder, "workspaceOrder"),
    };
}

export function applyPatch(
    current: ConversationPreferencesSnapshot,
    patch: ConversationPreferencesPatch,
): ConversationPreferencesSnapshot {
    const missing = patch.ifMissing === true;
    const hiddenContexts = { ...current.hiddenContexts };
    for (const [key, value] of Object.entries(patch.hiddenContexts ?? {})) {
        if (missing && Object.hasOwn(current.hiddenContexts, key)) continue;
        if (value === null) delete hiddenContexts[key];
        else hiddenContexts[key] = true;
    }
    const nextTitles = { ...current.titles };
    for (const [key, value] of Object.entries(patch.titles ?? {})) {
        if (missing && Object.hasOwn(current.titles, key)) continue;
        if (value === null) delete nextTitles[key];
        else nextTitles[key] = value;
    }
    const orderByWorkspace = { ...current.orderByWorkspace };
    for (const [workspace, order] of Object.entries(
        patch.orderByWorkspace ?? {},
    )) {
        const existing = current.orderByWorkspace[workspace];
        orderByWorkspace[workspace] =
            missing && existing !== undefined
                ? [...order.filter((key) => !existing.includes(key)), ...existing]
                : [...order];
    }
    const workspaceOrder =
        patch.workspaceOrder === undefined
            ? [...current.workspaceOrder]
            : missing
              ? [
                    ...current.workspaceOrder,
                    ...patch.workspaceOrder.filter(
                        (workspace) => !current.workspaceOrder.includes(workspace),
                    ),
                ]
              : [...patch.workspaceOrder];
    return {
        hiddenContexts,
        orderByWorkspace,
        titles: nextTitles,
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder,
    };
}

export function clonePreferences(
    value: ConversationPreferencesSnapshot,
): ConversationPreferencesSnapshot {
    return structuredClone(value);
}

export function samePreferences(
    left: ConversationPreferencesSnapshot,
    right: ConversationPreferencesSnapshot,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function hidden(value: unknown, nullable: boolean): Record<string, true | null> {
    const record = entries(value, "Conversation preferences hiddenContexts");
    return Object.fromEntries(
        record.map(([key, item]) => {
            keyOf(key, "Context id");
            if (nullable && item === null) return [key, null];
            if (item !== true)
                throw new TypeError(
                    "Conversation hidden Context values must be true or null.",
                );
            return [key, true];
        }),
    );
}

function orders(value: unknown): Record<string, string[]> {
    return Object.fromEntries(
        entries(value, "Conversation preferences orderByWorkspace").map(
            ([workspace, order]) => {
                keyOf(workspace, "workspace");
                return [
                    workspace,
                    list(order, `orderByWorkspace.${workspace}`),
                ];
            },
        ),
    );
}

function titles(
    value: unknown,
    nullable: boolean,
): Record<string, string | null> {
    return Object.fromEntries(
        entries(value, "Conversation preferences titles").map(([key, title]) => {
            keyOf(key, "conversation key");
            if (nullable && title === null) return [key, null];
            if (
                typeof title !== "string" ||
                title.length < 1 ||
                title.length > MAX_TITLE_LENGTH
            )
                throw new TypeError(
                    `Conversation title must contain 1-${MAX_TITLE_LENGTH} characters.`,
                );
            return [key, title];
        }),
    );
}

function list(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > MAX_KEYS)
        throw new TypeError(
            `Conversation preferences ${label} must be an array with at most ${MAX_KEYS} items.`,
        );
    const output: string[] = [];
    for (const item of value) {
        if (typeof item !== "string")
            throw new TypeError(
                `Conversation preferences ${label} items must be strings.`,
            );
        keyOf(item, label);
        if (!output.includes(item)) output.push(item);
    }
    return output;
}

function entries(value: unknown, label: string): [string, unknown][] {
    const result = Object.entries(object(value, label));
    if (result.length > MAX_KEYS)
        throw new TypeError(`${label} contains too many entries.`);
    return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TypeError(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

function keyOf(value: string, label: string): void {
    if (value.length < 1 || value.length > MAX_KEY_LENGTH)
        throw new TypeError(
            `Conversation preferences ${label} must contain 1-${MAX_KEY_LENGTH} characters.`,
        );
}

function only(record: Record<string, unknown>, allowed: readonly string[]): void {
    const unknown = Object.keys(record).find((key) => !allowed.includes(key));
    if (unknown !== undefined)
        throw new TypeError(
            `Unknown Conversation preferences field: ${unknown}.`,
        );
}
