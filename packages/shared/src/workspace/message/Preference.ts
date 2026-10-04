export const MESSAGE_PREFERENCES_VERSION = 1 as const;
export interface MessagePreferencesSnapshot {
    hiddenContexts: Record<string, true>;
    orderByWorkspace: Record<string, string[]>;
    titles: Record<string, string>;
    version: typeof MESSAGE_PREFERENCES_VERSION;
    workspaceOrder: string[];
}
export interface MessagePreferencesPatch {
    hiddenContexts?: Record<string, true | null>;
    ifMissing?: boolean;
    orderByWorkspace?: Record<string, string[]>;
    titles?: Record<string, string | null>;
    workspaceOrder?: string[];
}
export function createEmptyMessagePreferences(): MessagePreferencesSnapshot {
    return {
        hiddenContexts: {},
        orderByWorkspace: {},
        titles: {},
        version: MESSAGE_PREFERENCES_VERSION,
        workspaceOrder: [],
    };
}
const MAX_PREFERENCE_KEYS = 10_000;
const MAX_PREFERENCE_KEY_LENGTH = 8_192;
const MAX_MESSAGE_TITLE_LENGTH = 120;
export function parseMessagePreferencesPatch(
    value: unknown,
): MessagePreferencesPatch {
    const record = requireRecord(value, "Message preferences patch");
    rejectUnknownKeys(record, [
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
export function parseMessagePreferencesSnapshot(
    value: unknown,
): MessagePreferencesSnapshot {
    const record = requireRecord(value, "Message preferences");
    rejectUnknownKeys(record, [
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
                : (parseHiddenContexts(record.hiddenContexts, false) as Record<
                      string,
                      true
                  >),
        orderByWorkspace: parseOrderByWorkspace(record.orderByWorkspace),
        titles: parseTitles(record.titles, false) as Record<string, string>,
        version: MESSAGE_PREFERENCES_VERSION,
        workspaceOrder: parseStringList(
            record.workspaceOrder,
            "workspaceOrder",
        ),
    };
}
export function applyMessagePreferencesPatch(
    current: MessagePreferencesSnapshot,
    patch: MessagePreferencesPatch,
): MessagePreferencesSnapshot {
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
                ? [
                      ...order.filter((key) => !existing.includes(key)),
                      ...existing,
                  ]
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
        version: MESSAGE_PREFERENCES_VERSION,
        workspaceOrder,
    };
}
export function cloneMessagePreferences(
    value: MessagePreferencesSnapshot,
): MessagePreferencesSnapshot {
    return {
        hiddenContexts: { ...value.hiddenContexts },
        orderByWorkspace: Object.fromEntries(
            Object.entries(value.orderByWorkspace).map(([key, order]) => [
                key,
                [...order],
            ]),
        ),
        titles: { ...value.titles },
        version: MESSAGE_PREFERENCES_VERSION,
        workspaceOrder: [...value.workspaceOrder],
    };
}
export function sameMessagePreferences(
    left: MessagePreferencesSnapshot,
    right: MessagePreferencesSnapshot,
): boolean {
    return (
        sameStringList(left.workspaceOrder, right.workspaceOrder) &&
        sameRecord(left.hiddenContexts, right.hiddenContexts) &&
        sameRecord(left.titles, right.titles) &&
        sameOrderByWorkspace(left.orderByWorkspace, right.orderByWorkspace)
    );
}
function parseHiddenContexts(
    value: unknown,
    allowNull: boolean,
): Record<string, true | null> {
    const record = requireRecord(
        value,
        "Message preferences hiddenContexts",
    );
    const entries = Object.entries(record);
    if (entries.length > MAX_PREFERENCE_KEYS)
        throw new TypeError(
            "Message preferences contains too many hidden Contexts.",
        );
    return Object.fromEntries(
        entries.map(([ctxId, hidden]) => {
            validatePreferenceKey(ctxId, "Context id");
            if (allowNull && hidden === null) return [ctxId, null];
            if (hidden !== true)
                throw new TypeError(
                    "Message hidden Context values must be true or null.",
                );
            return [ctxId, true];
        }),
    );
}
function parseOrderByWorkspace(value: unknown): Record<string, string[]> {
    const record = requireRecord(
        value,
        "Message preferences orderByWorkspace",
    );
    const entries = Object.entries(record);
    if (entries.length > MAX_PREFERENCE_KEYS)
        throw new TypeError(
            "Message preferences contains too many workspaces.",
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
    const record = requireRecord(value, "Message preferences titles");
    const entries = Object.entries(record);
    if (entries.length > MAX_PREFERENCE_KEYS)
        throw new TypeError(
            "Message preferences contains too many titles.",
        );
    return Object.fromEntries(
        entries.map(([key, title]) => {
            validatePreferenceKey(key, "message key");
            if (allowNull && title === null) return [key, null];
            if (
                typeof title !== "string" ||
                title.length < 1 ||
                title.length > MAX_MESSAGE_TITLE_LENGTH
            )
                throw new TypeError(
                    `Message title must contain 1-${MAX_MESSAGE_TITLE_LENGTH} characters.`,
                );
            return [key, title];
        }),
    );
}
function parseStringList(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > MAX_PREFERENCE_KEYS)
        throw new TypeError(
            `Message preferences ${label} must be an array with at most ${MAX_PREFERENCE_KEYS} items.`,
        );
    const output: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string")
            throw new TypeError(
                `Message preferences ${label} items must be strings.`,
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
            `Message preferences ${label} must contain 1-${MAX_PREFERENCE_KEY_LENGTH} characters.`,
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
            `Unknown Message preferences field: ${unknown}.`,
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
function sameStringList(
    left: readonly string[],
    right: readonly string[],
): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}
