import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
    createRemoteError,
    errorMessage,
    toRemoteErrorBody,
    type JsonValue,
    type ToolCallContext,
    type WaitDetachInput,
    type WaitRecord,
} from "@portable-devshell/shared";

export const WAIT_SYNC_MS = 120_000;
export const WAIT_HANDOFF_MS = 180_000;
const WAIT_TERMINAL_RETENTION = 128;

export interface WaitInvokePort {
    invoke(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
}

export interface WaitServiceOptions {
    appendEvent(type: string, data: JsonValue): Promise<void>;
    filePath: string;
    invoke: WaitInvokePort;
    now?: () => string;
    waitId?: () => string;
}

type WaitEventType = "wait.detached" | "wait.resolved" | "wait.failed";

interface WaitNotification {
    type: WaitEventType;
    record: WaitRecord;
}

interface WaitDocument {
    version: 1;
    waits: WaitRecord[];
    notifications: WaitNotification[];
}

export class WaitService {
    readonly #appendEvent: WaitServiceOptions["appendEvent"];
    readonly #filePath: string;
    readonly #invoke: WaitInvokePort;
    readonly #now: () => string;
    readonly #waitId: () => string;
    #records = new Map<string, WaitRecord>();
    #notifications: WaitNotification[] = [];
    readonly #monitors = new Map<string, AbortController>();
    readonly #monitorTasks = new Map<string, Promise<void>>();
    readonly #monitorFailures: unknown[] = [];
    #operation: Promise<void> = Promise.resolve();
    #pending?: {
        document: WaitDocument;
        start?: WaitRecord;
    };
    #retryTimer?: ReturnType<typeof setTimeout>;
    #closed = false;
    #closePromise?: Promise<void>;

    constructor(options: WaitServiceOptions) {
        this.#appendEvent = options.appendEvent;
        this.#filePath = options.filePath;
        this.#invoke = options.invoke;
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#waitId = options.waitId ?? (() => `wait-${randomUUID()}`);
        const document = readDocument(this.#filePath);
        for (const record of document.waits)
            this.#records.set(record.waitId, record);
        this.#notifications = document.notifications;
    }

    async list(ctxId?: string): Promise<WaitRecord[]> {
        return await this.#exclusive(async () =>
            [...this.#records.values()]
                .filter((record) => ctxId === undefined || record.ctxId === ctxId)
                .map((record) => structuredClone(record)));
    }

    async detach(input: WaitDetachInput): Promise<WaitRecord> {
        return await this.#exclusive(async () => {
            if (this.#closed) throw new Error("Wait service is closed.");
            const existing = [...this.#records.values()].find(
                (record) =>
                    record.status === "detached" &&
                    record.targetId === input.targetId &&
                    record.ctxId === input.ctxId,
            );
            if (existing !== undefined) {
                this.#start(existing);
                return structuredClone(existing);
            }
            const now = this.#now();
            const record: WaitRecord = {
                callId: input.callId,
                createdAt: now,
                ...(input.ctxId === undefined ? {} : { ctxId: input.ctxId }),
                instance: input.instance,
                source: input.source,
                status: "detached",
                targetId: input.targetId,
                toolName: input.toolName,
                updatedAt: now,
                waitId: this.#waitId(),
                ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
            };
            const next = new Map(this.#records);
            next.set(record.waitId, record);
            const warning = await this.#persist(next, [
                ...this.#notifications, { type: "wait.detached", record },
            ], record);
            this.#start(record);
            await this.#deliverNotifications();
            if (warning !== undefined) throw warning;
            return structuredClone(record);
        });
    }

    resume(): void {
        if (this.#closed) return;
        void this.#exclusive(async () => {
            for (const record of this.#records.values())
                if (record.status === "detached") this.#start(record);
            await this.#deliverNotifications();
        }).catch((error: unknown) =>
            console.warn("Wait recovery could not read committed state:", error));
    }

    close(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        this.#closed = true;
        if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
        for (const controller of this.#monitors.values()) controller.abort();
        this.#closePromise = (async () => {
            await Promise.allSettled(this.#monitorTasks.values());
            await this.#operation;
            if (this.#monitorFailures.length > 0)
                throw new AggregateError(
                    this.#monitorFailures,
                    "Wait monitors failed while closing.",
                );
        })();
        return this.#closePromise;
    }

    #start(record: WaitRecord): void {
        if (this.#closed || this.#monitors.has(record.waitId)) return;
        const controller = new AbortController();
        this.#monitors.set(record.waitId, controller);
        const task = this.#monitor(record.waitId, controller.signal);
        this.#monitorTasks.set(record.waitId, task);
        void task.then(
            () => this.#finishMonitor(record.waitId, controller, task),
            (error: unknown) => {
                this.#monitorFailures.push(error);
                this.#finishMonitor(record.waitId, controller, task);
            },
        );
    }

    #finishMonitor(
        waitId: string,
        controller: AbortController,
        task: Promise<void>,
    ): void {
        if (this.#monitors.get(waitId) === controller)
            this.#monitors.delete(waitId);
        if (this.#monitorTasks.get(waitId) === task)
            this.#monitorTasks.delete(waitId);
    }

    async #monitor(waitId: string, signal: AbortSignal): Promise<void> {
        for (;;) {
            if (signal.aborted) return;
            const record = this.#records.get(waitId);
            if (record === undefined || record.status !== "detached") return;
            try {
                const result = await this.#invoke.invoke(
                    "tmux_read",
                    {
                        consumeOutput: false,
                        line: -1,
                        task: record.targetId,
                        timeMs: WAIT_SYNC_MS,
                    },
                    {
                        ...(record.ctxId === undefined ? {} : { ctxId: record.ctxId }),
                        source: record.source,
                        ...(record.workspace === undefined
                            ? {}
                            : { workspace: record.workspace }),
                    },
                    signal,
                );
                if (signal.aborted) return;
                if (readString(result, "waitReason") !== "terminal") continue;
                await this.#settleObserved(waitId, "resolved", { result }, signal);
                return;
            } catch (error) {
                if (signal.aborted) return;
                if (toRemoteErrorBody(error)?.code === "tmux.taskExpired") {
                    await this.#settleObserved(waitId, "failed", {
                        error: errorMessage(error),
                    }, signal);
                    return;
                }
                await delay(1_000, signal);
            }
        }
    }

    async #settleObserved(
        waitId: string,
        status: "resolved" | "failed",
        terminal: { result?: JsonValue; error?: string },
        signal: AbortSignal,
    ): Promise<void> {
        // A terminal observation is a fact. A failed state commit must never
        // cause another tmux_read that could report taskExpired instead.
        while (!signal.aborted) {
            try {
                await this.#settle(waitId, status, terminal);
                return;
            } catch (error) {
                if (signal.aborted) return;
                console.warn("Wait terminal state commit failed; retrying:", errorMessage(error));
                await delay(1_000, signal);
            }
        }
    }

    async #settle(
        waitId: string,
        status: "resolved" | "failed",
        terminal: { result?: JsonValue; error?: string },
    ): Promise<void> {
        await this.#exclusive(async () => {
            const current = this.#records.get(waitId);
            if (current === undefined || current.status !== "detached") return;
            const now = this.#now();
            const record: WaitRecord = {
                ...current,
                ...terminal,
                resolvedAt: now,
                status,
                updatedAt: now,
            };
            const next = new Map(this.#records);
            next.set(waitId, record);
            this.#pruneTerminal(next);
            const warning = await this.#persist(next, [
                ...this.#notifications, { type: `wait.${status}`, record },
            ]);
            await this.#deliverNotifications();
            if (warning !== undefined)
                console.warn("Wait terminal commit durability unconfirmed:", warning);
        });
    }

    #pruneTerminal(records: Map<string, WaitRecord>): void {
        const terminal = [...records.values()]
            .filter((record) => record.status !== "detached")
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        for (const record of terminal.slice(WAIT_TERMINAL_RETENTION))
            records.delete(record.waitId);
    }

    async #persist(
        next: Map<string, WaitRecord>,
        notifications: WaitNotification[],
        start?: WaitRecord,
    ): Promise<Error | undefined> {
        const document: WaitDocument = {
            version: 1,
            waits: [...next.values()],
            notifications,
        };
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.tmp.${process.pid}.${randomUUID()}`;
        try {
            const handle = await open(temporary, "wx", 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        try {
            await rename(temporary, this.#filePath);
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            let stored: WaitDocument;
            try {
                stored = readDocument(this.#filePath);
            } catch (probeError) {
                this.#pending = {
                    document,
                    ...(start === undefined ? {} : { start }),
                };
                throw createRemoteError({
                    code: "wait.commitUncertain",
                    cause: new AggregateError([error, probeError]),
                    message: "Wait commit outcome is unknown; read before retrying.",
                    retryable: false,
                });
            }
            this.#accept(stored);
            if (!isDeepStrictEqual(stored, document)) throw error;
            return createRemoteError({
                code: "wait.commitDurabilityUnconfirmed",
                cause: error,
                message: "Wait state is committed, but crash durability is unconfirmed.",
                retryable: false,
            });
        }
        this.#records = next;
        this.#notifications = notifications;
        if (process.platform !== "win32") {
            try {
                const handle = await open(directory, "r");
                try {
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            } catch (error) {
                return createRemoteError({
                    code: "wait.commitDurabilityUnconfirmed",
                    cause: error,
                    message: "Wait state is committed, but crash durability is unconfirmed.",
                    retryable: false,
                });
            }
        }
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#operation;
        let release!: () => void;
        this.#operation = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
            const pending = this.#pending;
            if (pending !== undefined) {
                const stored = readDocument(this.#filePath);
                this.#accept(stored);
                this.#pending = undefined;
                if (isDeepStrictEqual(stored, pending.document) && pending.start !== undefined)
                    this.#start(pending.start);
                await this.#deliverNotifications();
            }
            return await operation();
        } finally {
            release();
        }
    }

    #accept(document: WaitDocument): void {
        this.#records = new Map(document.waits.map((record) => [record.waitId, record]));
        this.#notifications = document.notifications;
    }

    async #deliverNotifications(): Promise<void> {
        while (!this.#closed && this.#notifications.length > 0) {
            const notification = this.#notifications[0]!;
            try {
                await this.#appendEvent(notification.type, notification.record as unknown as JsonValue);
                const warning = await this.#persist(this.#records, this.#notifications.slice(1));
                if (warning !== undefined)
                    console.warn("Wait event acknowledgement durability unconfirmed:", errorMessage(warning));
            } catch (error) {
                // An event is acknowledged only after its durable queue entry
                // is removed. A crash between append and ack may redeliver it;
                // consumers observe authoritative Wait state, not event counts.
                console.warn("Wait notification delivery failed; retrying:", errorMessage(error));
                this.#scheduleDelivery();
                return;
            }
        }
    }

    #scheduleDelivery(): void {
        if (this.#closed || this.#retryTimer !== undefined) return;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            if (this.#closed) return;
            void this.#exclusive(async () => await this.#deliverNotifications())
                .catch((error: unknown) => {
                    console.warn("Wait notification reconciliation failed:", errorMessage(error));
                    this.#scheduleDelivery();
                });
        }, 1_000);
        this.#retryTimer.unref?.();
    }
}

function readDocument(filePath: string): WaitDocument {
    if (!existsSync(filePath)) return { version: 1, waits: [], notifications: [] };
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.waits))
        throw new Error(`Wait state is invalid: ${filePath}`);
    if (value.notifications !== undefined && !Array.isArray(value.notifications))
        throw new Error(`Wait notifications are invalid: ${filePath}`);
    return {
        version: 1,
        waits: value.waits as unknown as WaitRecord[],
        notifications: (value.notifications ?? []) as unknown as WaitNotification[],
    };
}

function readString(value: JsonValue, field: string): string | undefined {
    return isRecord(value) && typeof value[field] === "string"
        ? value[field]
        : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}
