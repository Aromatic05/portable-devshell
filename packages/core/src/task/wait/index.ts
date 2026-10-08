import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
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

export class WaitService {
    readonly #appendEvent: WaitServiceOptions["appendEvent"];
    readonly #filePath: string;
    readonly #invoke: WaitInvokePort;
    readonly #now: () => string;
    readonly #waitId: () => string;
    readonly #records = new Map<string, WaitRecord>();
    readonly #monitors = new Map<string, AbortController>();
    readonly #monitorTasks = new Map<string, Promise<void>>();
    readonly #monitorFailures: unknown[] = [];
    #writeTail = Promise.resolve();
    #closed = false;
    #closePromise?: Promise<void>;

    constructor(options: WaitServiceOptions) {
        this.#appendEvent = options.appendEvent;
        this.#filePath = options.filePath;
        this.#invoke = options.invoke;
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#waitId = options.waitId ?? (() => `wait-${randomUUID()}`);
        for (const record of readDocument(this.#filePath))
            this.#records.set(record.waitId, record);
    }

    async list(ctxId?: string): Promise<WaitRecord[]> {
        return [...this.#records.values()]
            .filter((record) => ctxId === undefined || record.ctxId === ctxId)
            .map((record) => structuredClone(record));
    }

    async detach(input: WaitDetachInput): Promise<WaitRecord> {
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
        this.#records.set(record.waitId, record);
        await this.#persist();
        await this.#appendEvent("wait.detached", record as unknown as JsonValue);
        this.#start(record);
        return structuredClone(record);
    }

    resume(): void {
        if (this.#closed) return;
        for (const record of this.#records.values())
            if (record.status === "detached") this.#start(record);
    }

    close(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        this.#closed = true;
        for (const controller of this.#monitors.values()) controller.abort();
        this.#closePromise = (async () => {
            await Promise.allSettled(this.#monitorTasks.values());
            await this.#writeTail;
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
                await this.#settle(waitId, "resolved", { result });
                return;
            } catch (error) {
                if (signal.aborted) return;
                if (toRemoteErrorBody(error)?.code === "tmux.taskExpired") {
                    await this.#settle(waitId, "failed", {
                        error: errorMessage(error),
                    });
                    return;
                }
                await delay(1_000);
            }
        }
    }

    async #settle(
        waitId: string,
        status: "resolved" | "failed",
        terminal: { result?: JsonValue; error?: string },
    ): Promise<void> {
        const current = this.#records.get(waitId);
        if (current === undefined || current.status !== "detached") return;
        const now = this.#now();
        const next: WaitRecord = {
            ...current,
            ...terminal,
            resolvedAt: now,
            status,
            updatedAt: now,
        };
        this.#records.set(waitId, next);
        this.#pruneTerminal();
        await this.#persist();
        await this.#appendEvent(`wait.${status}`, next as unknown as JsonValue);
    }

    #pruneTerminal(): void {
        const terminal = [...this.#records.values()]
            .filter((record) => record.status !== "detached")
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        for (const record of terminal.slice(WAIT_TERMINAL_RETENTION))
            this.#records.delete(record.waitId);
    }

    async #persist(): Promise<void> {
        const body = `${JSON.stringify({ version: 1, waits: [...this.#records.values()] })}\n`;
        this.#writeTail = this.#writeTail.catch(() => undefined).then(async () => {
            const directory = dirname(this.#filePath);
            await mkdir(directory, { mode: 0o700, recursive: true });
            const temporary = `${this.#filePath}.tmp.${process.pid}.${randomUUID()}`;
            try {
                await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
                await rename(temporary, this.#filePath);
            } catch (error) {
                await unlink(temporary).catch(() => undefined);
                throw error;
            }
        });
        await this.#writeTail;
    }
}

function readDocument(filePath: string): WaitRecord[] {
    if (!existsSync(filePath)) return [];
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.waits))
        throw new Error(`Wait state is invalid: ${filePath}`);
    return value.waits as unknown as WaitRecord[];
}

function readString(value: JsonValue, field: string): string | undefined {
    return isRecord(value) && typeof value[field] === "string"
        ? value[field]
        : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
