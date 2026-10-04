import type {
    MessagePreferencesPatch,
    MessagePreferencesSnapshot,
} from "@portable-devshell/shared";

export const MESSAGE_PREFERENCES_VERSION = 1 as const;

const MAX_KEYS = 10_000;
const MAX_KEY_LENGTH = 8_192;
const MAX_TITLE_LENGTH = 120;

export function createEmptyMessagePreferences(): MessagePreferencesSnapshot {
    return {
        hiddenContexts: {},
        orderByWorkspace: {},
        titles: {},
        version: MESSAGE_PREFERENCES_VERSION,
        workspaceOrder: [],
    };
}

export function parseMessagePreferencesPatch(
    value: unknown,
): MessagePreferencesPatch {
    const record = object(value, "Message preferences patch");
    only(record, [
        "hiddenContexts",
        "ifMissing",
        "orderByWorkspace",
        "titles",
        "workspaceOrder",
    ]);
    if (record.ifMissing !== undefined && typeof record.ifMissing !== "boolean")
        throw new TypeError(
            "Message preferences ifMissing must be a boolean.",
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

export function parseMessagePreferencesSnapshot(
    value: unknown,
): MessagePreferencesSnapshot {
    const record = object(value, "Message preferences");
    only(record, [
        "hiddenContexts",
        "orderByWorkspace",
        "titles",
        "version",
        "workspaceOrder",
    ]);
    if (record.version !== MESSAGE_PREFERENCES_VERSION)
        throw new TypeError(
            `Unsupported Message preferences version: ${String(record.version)}.`,
        );
    return {
        hiddenContexts:
            record.hiddenContexts === undefined
                ? {}
                : (hidden(record.hiddenContexts, false) as Record<string, true>),
        orderByWorkspace: orders(record.orderByWorkspace),
        titles: titles(record.titles, false) as Record<string, string>,
        version: MESSAGE_PREFERENCES_VERSION,
        workspaceOrder: list(record.workspaceOrder, "workspaceOrder"),
    };
}

export function applyPatch(
    current: MessagePreferencesSnapshot,
    patch: MessagePreferencesPatch,
): MessagePreferencesSnapshot {
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
        version: MESSAGE_PREFERENCES_VERSION,
        workspaceOrder,
    };
}

export function clonePreferences(
    value: MessagePreferencesSnapshot,
): MessagePreferencesSnapshot {
    return structuredClone(value);
}

export function samePreferences(
    left: MessagePreferencesSnapshot,
    right: MessagePreferencesSnapshot,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function hidden(value: unknown, nullable: boolean): Record<string, true | null> {
    const record = entries(value, "Message preferences hiddenContexts");
    return Object.fromEntries(
        record.map(([key, item]) => {
            keyOf(key, "Context id");
            if (nullable && item === null) return [key, null];
            if (item !== true)
                throw new TypeError(
                    "Message hidden Context values must be true or null.",
                );
            return [key, true];
        }),
    );
}

function orders(value: unknown): Record<string, string[]> {
    return Object.fromEntries(
        entries(value, "Message preferences orderByWorkspace").map(
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
        entries(value, "Message preferences titles").map(([key, title]) => {
            keyOf(key, "message key");
            if (nullable && title === null) return [key, null];
            if (
                typeof title !== "string" ||
                title.length < 1 ||
                title.length > MAX_TITLE_LENGTH
            )
                throw new TypeError(
                    `Message title must contain 1-${MAX_TITLE_LENGTH} characters.`,
                );
            return [key, title];
        }),
    );
}

function list(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > MAX_KEYS)
        throw new TypeError(
            `Message preferences ${label} must be an array with at most ${MAX_KEYS} items.`,
        );
    const output: string[] = [];
    for (const item of value) {
        if (typeof item !== "string")
            throw new TypeError(
                `Message preferences ${label} items must be strings.`,
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
            `Message preferences ${label} must contain 1-${MAX_KEY_LENGTH} characters.`,
        );
}

function only(record: Record<string, unknown>, allowed: readonly string[]): void {
    const unknown = Object.keys(record).find((key) => !allowed.includes(key));
    if (unknown !== undefined)
        throw new TypeError(
            `Unknown Message preferences field: ${unknown}.`,
        );
}
