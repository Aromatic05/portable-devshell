import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
    CONVERSATION_PREFERENCES_VERSION,
    createEmptyConversationPreferences,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
} from "@portable-devshell/shared";

const MAX_KEYS = 10_000;
const MAX_KEY_LENGTH = 8_192;
const MAX_TITLE_LENGTH = 120;

export class ConversationPreferenceStore {
    readonly #filePath: string;
    #operationQueue = Promise.resolve();

    constructor(filePath: string) {
        this.#filePath = filePath;
    }

    async read(): Promise<ConversationPreferencesSnapshot> {
        return await this.#exclusive(async () => await this.#read());
    }

    async update(patch: ConversationPreferencesPatch): Promise<ConversationPreferencesSnapshot> {
        const normalized = parseConversationPreferencesPatch(patch);
        return await this.#exclusive(async () => {
            const current = await this.#read();
            const next = applyPatch(current, normalized);
            if (samePreferences(current, next)) return current;
            await this.#write(next);
            return clonePreferences(next);
        });
    }

    async #read(): Promise<ConversationPreferencesSnapshot> {
        const source = await readFile(this.#filePath, "utf8").catch((error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
        });
        if (source === undefined) return createEmptyConversationPreferences();
        return parseConversationPreferencesSnapshot(JSON.parse(source) as unknown);
    }

    async #write(snapshot: ConversationPreferencesSnapshot): Promise<void> {
        const validated = parseConversationPreferencesSnapshot(snapshot);
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
            await handle.sync();
        } catch (error) {
            await handle.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        await handle.close();
        try {
            await rename(temporary, this.#filePath);
            if (process.platform !== "win32") {
                const directoryHandle = await open(directory, "r");
                try {
                    await directoryHandle.sync();
                } finally {
                    await directoryHandle.close();
                }
            }
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.#operationQueue.then(operation, operation);
        this.#operationQueue = next.then(() => undefined, () => undefined);
        return await next;
    }
}

export function parseConversationPreferencesPatch(value: unknown): ConversationPreferencesPatch {
    const record = requireRecord(value, "Conversation preferences patch");
    rejectUnknownKeys(record, ["ifMissing", "orderByWorkspace", "titles", "workspaceOrder"]);
    if (record.ifMissing !== undefined && typeof record.ifMissing !== "boolean") {
        throw new TypeError("Conversation preferences ifMissing must be a boolean.");
    }
    return {
        ...(record.ifMissing === undefined ? {} : { ifMissing: record.ifMissing }),
        ...(record.orderByWorkspace === undefined ? {} : {
            orderByWorkspace: parseOrderByWorkspace(record.orderByWorkspace),
        }),
        ...(record.titles === undefined ? {} : { titles: parseTitles(record.titles, true) }),
        ...(record.workspaceOrder === undefined ? {} : {
            workspaceOrder: parseStringList(record.workspaceOrder, "workspaceOrder"),
        }),
    };
}

function parseConversationPreferencesSnapshot(value: unknown): ConversationPreferencesSnapshot {
    const record = requireRecord(value, "Conversation preferences");
    rejectUnknownKeys(record, ["orderByWorkspace", "titles", "version", "workspaceOrder"]);
    if (record.version !== CONVERSATION_PREFERENCES_VERSION) {
        throw new TypeError(`Unsupported Conversation preferences version: ${String(record.version)}.`);
    }
    return {
        orderByWorkspace: parseOrderByWorkspace(record.orderByWorkspace),
        titles: parseTitles(record.titles, false) as Record<string, string>,
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder: parseStringList(record.workspaceOrder, "workspaceOrder"),
    };
}

function applyPatch(
    current: ConversationPreferencesSnapshot,
    patch: ConversationPreferencesPatch,
): ConversationPreferencesSnapshot {
    const missingOnly = patch.ifMissing === true;
    const titles = { ...current.titles };
    for (const [key, title] of Object.entries(patch.titles ?? {})) {
        if (missingOnly && Object.hasOwn(current.titles, key)) continue;
        if (title === null) delete titles[key];
        else titles[key] = title;
    }
    const orderByWorkspace = { ...current.orderByWorkspace };
    for (const [workspace, order] of Object.entries(patch.orderByWorkspace ?? {})) {
        const existing = current.orderByWorkspace[workspace];
        orderByWorkspace[workspace] = missingOnly && existing !== undefined
            ? [...order.filter((key) => !existing.includes(key)), ...existing]
            : [...order];
    }
    const workspaceOrder = patch.workspaceOrder === undefined
        ? [...current.workspaceOrder]
        : missingOnly
          ? [
                ...current.workspaceOrder,
                ...patch.workspaceOrder.filter((workspace) => !current.workspaceOrder.includes(workspace)),
            ]
          : [...patch.workspaceOrder];
    return {
        orderByWorkspace,
        titles,
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder,
    };
}

function parseOrderByWorkspace(value: unknown): Record<string, string[]> {
    const record = requireRecord(value, "Conversation preferences orderByWorkspace");
    const entries = Object.entries(record);
    if (entries.length > MAX_KEYS) throw new TypeError("Conversation preferences contains too many workspaces.");
    return Object.fromEntries(entries.map(([workspace, order]) => {
        validateKey(workspace, "workspace");
        return [workspace, parseStringList(order, `orderByWorkspace.${workspace}`)];
    }));
}

function parseTitles(value: unknown, allowNull: boolean): Record<string, string | null> {
    const record = requireRecord(value, "Conversation preferences titles");
    const entries = Object.entries(record);
    if (entries.length > MAX_KEYS) throw new TypeError("Conversation preferences contains too many titles.");
    return Object.fromEntries(entries.map(([key, title]) => {
        validateKey(key, "conversation key");
        if (allowNull && title === null) return [key, null];
        if (typeof title !== "string" || title.length < 1 || title.length > MAX_TITLE_LENGTH) {
            throw new TypeError(`Conversation title must contain 1-${MAX_TITLE_LENGTH} characters.`);
        }
        return [key, title];
    }));
}

function parseStringList(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length > MAX_KEYS) {
        throw new TypeError(`Conversation preferences ${label} must be an array with at most ${MAX_KEYS} items.`);
    }
    const output: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") throw new TypeError(`Conversation preferences ${label} items must be strings.`);
        validateKey(item, label);
        if (!seen.has(item)) {
            seen.add(item);
            output.push(item);
        }
    }
    return output;
}

function validateKey(value: string, label: string): void {
    if (value.length < 1 || value.length > MAX_KEY_LENGTH) {
        throw new TypeError(`Conversation preferences ${label} must contain 1-${MAX_KEY_LENGTH} characters.`);
    }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
    if (unknown !== undefined) throw new TypeError(`Unknown Conversation preferences field: ${unknown}.`);
}

function clonePreferences(value: ConversationPreferencesSnapshot): ConversationPreferencesSnapshot {
    return {
        orderByWorkspace: Object.fromEntries(Object.entries(value.orderByWorkspace).map(([key, order]) => [key, [...order]])),
        titles: { ...value.titles },
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder: [...value.workspaceOrder],
    };
}

function samePreferences(left: ConversationPreferencesSnapshot, right: ConversationPreferencesSnapshot): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
}
