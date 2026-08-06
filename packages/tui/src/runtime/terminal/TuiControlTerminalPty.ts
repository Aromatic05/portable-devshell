import type {
    ClientEvent,
    TerminalAttachInput,
    TerminalOpenInput,
    TerminalOpenResult,
    TerminalSessionDescriptor,
    TerminalVersionedIdentity,
} from "@portable-devshell/shared";

import type {
    TuiTerminalDisposable,
    TuiTerminalPty,
    TuiTerminalPtyFactory,
    TuiTerminalPtyOptions,
} from "./TuiTerminalModel.js";

const OPERATION_ACK_TIMEOUT_MS = 30_000;

export interface TuiControlTerminalStream {
    close(): void;
    nextEvent(): Promise<ClientEvent>;
    send(
        operation: string,
        payload?: import("@portable-devshell/shared").JsonValue,
    ): Promise<void>;
}

export interface TuiOpenedTerminalStream {
    acknowledgement: ClientEvent;
    stream: TuiControlTerminalStream;
}

export interface TuiControlTerminalClient {
    attach(
        instance: string,
        input: TerminalAttachInput,
    ): Promise<TuiOpenedTerminalStream>;
    kill(
        instance: string,
        identity: TerminalVersionedIdentity,
    ): Promise<TerminalSessionDescriptor>;
    open(
        instance: string,
        input: TerminalOpenInput,
    ): Promise<TerminalOpenResult>;
}

interface StoredTerminalIdentity extends TerminalSessionDescriptor {}

interface PendingOperation {
    reject(error: Error): void;
    resolve(): void;
    timer: ReturnType<typeof setTimeout>;
}

export class TuiControlTerminalPtyFactory {
    readonly #client: TuiControlTerminalClient;
    readonly #operationAckTimeoutMs: number;
    readonly #sessions = new Map<string, StoredTerminalIdentity>();

    constructor(options: {
        client: TuiControlTerminalClient;
        operationAckTimeoutMs?: number;
    }) {
        this.#client = options.client;
        this.#operationAckTimeoutMs =
            options.operationAckTimeoutMs ?? OPERATION_ACK_TIMEOUT_MS;
        if (
            !Number.isSafeInteger(this.#operationAckTimeoutMs) ||
            this.#operationAckTimeoutMs < 1
        ) {
            throw new TypeError(
                "Terminal operationAckTimeoutMs must be a positive safe integer.",
            );
        }
    }

    create(instance?: string): TuiTerminalPtyFactory {
        return (command, _args, options) => {
            const targetInstance = instance ?? command;
            return new TuiControlTerminalPty({
                client: this.#client,
                instance: targetInstance,
                operationAckTimeoutMs: this.#operationAckTimeoutMs,
                options,
                readIdentity: () => this.#sessions.get(targetInstance),
                writeIdentity: (identity) =>
                    this.#sessions.set(targetInstance, identity),
            });
        };
    }

    async kill(instance: string): Promise<TerminalSessionDescriptor | undefined> {
        const identity = this.#sessions.get(instance);
        if (identity === undefined || identity.state !== "running") {
            return undefined;
        }
        const killed = await this.#client.kill(instance, {
            generation: identity.generation,
            terminalId: identity.terminalId,
            version: identity.version,
        });
        const current = this.#sessions.get(instance);
        if (
            current?.terminalId === identity.terminalId &&
            current.generation === identity.generation &&
            killed.version >= current.version
        ) {
            this.#sessions.set(instance, { ...killed });
        }
        return killed;
    }

    snapshot(instance: string): TerminalSessionDescriptor | undefined {
        const identity = this.#sessions.get(instance);
        return identity === undefined ? undefined : { ...identity };
    }
}

class TuiControlTerminalPty implements TuiTerminalPty {
    readonly #client: TuiControlTerminalClient;
    readonly #dataListeners = new Set<(data: string) => void>();
    readonly #exitListeners = new Set<
        (event: { exitCode: number; signal?: number }) => void
    >();
    readonly #instance: string;
    readonly #operationAckTimeoutMs: number;
    readonly #options: TuiTerminalPtyOptions;
    readonly #pending = new Map<number, PendingOperation>();
    readonly #readIdentity: () => StoredTerminalIdentity | undefined;
    readonly #writeIdentity: (identity: StoredTerminalIdentity) => void;
    readonly #ready: Promise<void>;
    #clientSeq = 0;
    #closed = false;
    #exited = false;
    #operationTail = Promise.resolve();
    #stream?: TuiControlTerminalStream;

    constructor(options: {
        client: TuiControlTerminalClient;
        instance: string;
        operationAckTimeoutMs: number;
        options: TuiTerminalPtyOptions;
        readIdentity(): StoredTerminalIdentity | undefined;
        writeIdentity(identity: StoredTerminalIdentity): void;
    }) {
        this.#client = options.client;
        this.#instance = options.instance;
        this.#operationAckTimeoutMs = options.operationAckTimeoutMs;
        this.#options = options.options;
        this.#readIdentity = options.readIdentity;
        this.#writeIdentity = options.writeIdentity;
        this.#ready = this.#connect().catch((error: unknown) => {
            this.#fail(asError(error), false);
            throw error;
        });
        void this.#ready.catch(() => undefined);
    }

    kill(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#stream?.close();
        this.#stream = undefined;
        this.#rejectPending(new Error("Terminal attachment was detached."));
    }

    onData(listener: (data: string) => void): TuiTerminalDisposable {
        this.#dataListeners.add(listener);
        return { dispose: () => this.#dataListeners.delete(listener) };
    }

    onExit(
        listener: (event: { exitCode: number; signal?: number }) => void,
    ): TuiTerminalDisposable {
        this.#exitListeners.add(listener);
        return { dispose: () => this.#exitListeners.delete(listener) };
    }

    resize(columns: number, rows: number): void {
        this.#enqueueOperation("resize", { cols: columns, rows });
    }

    write(data: string): void {
        this.#enqueueOperation("input", { data });
    }

    async #connect(): Promise<void> {
        let identity = this.#readIdentity();
        if (identity === undefined || identity.state !== "running") {
            identity = await this.#client.open(this.#instance, {
                cols: this.#options.columns,
                rows: this.#options.rows,
            });
            this.#writeIdentity({ ...identity });
        }
        // Every TUI attachment creates a fresh local terminal buffer. Replay
        // durable server output from the beginning so reopening the terminal
        // restores the screen instead of resuming after unseen output.
        const fromSeq = 0;
        const opened = await this.#client.attach(this.#instance, {
            fromSeq,
            generation: identity.generation,
            terminalId: identity.terminalId,
        });
        if (this.#closed) {
            opened.stream.close();
            return;
        }
        const acknowledged = readSession(opened.acknowledgement);
        this.#writeIdentity({ ...acknowledged, latestSeq: fromSeq });
        this.#stream = opened.stream;
        void this.#consume(opened.stream).catch((error: unknown) => {
            if (!this.#closed)
                this.#fail(asError(error), this.#pending.size > 0);
        });
    }

    #enqueueOperation(
        operation: "input" | "resize",
        payload: { data: string } | { cols: number; rows: number },
    ): void {
        this.#operationTail = this.#operationTail
            .then(async () => {
                await this.#ready;
                if (this.#closed)
                    throw new Error("Terminal attachment is closed.");
                const stream = this.#stream;
                const identity = this.#readIdentity();
                if (stream === undefined || identity === undefined) {
                    throw new Error("Terminal attachment is not ready.");
                }
                const clientSeq = ++this.#clientSeq;
                const acknowledged = new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        this.#pending.delete(clientSeq);
                        reject(
                            new Error(
                                `Terminal ${operation} result is unknown because no acknowledgement was received.`,
                            ),
                        );
                    }, this.#operationAckTimeoutMs);
                    timer.unref?.();
                    this.#pending.set(clientSeq, { reject, resolve, timer });
                });
                try {
                    await stream.send(operation, {
                        clientSeq,
                        generation: identity.generation,
                        terminalId: identity.terminalId,
                        version: identity.version,
                        ...payload,
                    });
                    await acknowledged;
                } catch (error) {
                    const pending = this.#pending.get(clientSeq);
                    if (pending !== undefined) {
                        clearTimeout(pending.timer);
                        this.#pending.delete(clientSeq);
                        pending.reject(asError(error));
                    }
                    throw error;
                }
            })
            .catch((error: unknown) => {
                if (!this.#closed) this.#fail(asError(error), true);
            });
    }

    async #consume(stream: TuiControlTerminalStream): Promise<void> {
        while (!this.#closed && this.#stream === stream) {
            const event = await stream.nextEvent();
            if (event.name === "terminal.output") {
                const frame = readOutput(event);
                const identity = this.#requireIdentity();
                if (frame.seq <= identity.latestSeq) continue;
                if (frame.seq !== identity.latestSeq + 1) {
                    throw new Error(
                        `Terminal output gap: expected ${identity.latestSeq + 1}, received ${frame.seq}.`,
                    );
                }
                const updated = { ...identity, latestSeq: frame.seq };
                this.#writeIdentity(updated);
                this.#emitData(frame.data);
                await stream.send("ack", {
                    generation: updated.generation,
                    terminalId: updated.terminalId,
                    throughSeq: frame.seq,
                    version: updated.version,
                });
                continue;
            }
            if (
                event.name === "terminal.inputAccepted" ||
                event.name === "terminal.resized"
            ) {
                this.#acceptOperation(event);
                continue;
            }
            if (event.name === "terminal.exit") {
                const exit = readExit(event);
                const identity = this.#requireIdentity();
                this.#writeIdentity({
                    ...identity,
                    state: "exited",
                });
                this.#emitExit(exit);
                continue;
            }
            if (event.name === "stream.completed") {
                this.#writeIdentity(readCompletedSession(event));
                this.#stream = undefined;
                stream.close();
                return;
            }
            if (event.name === "stream.cancelled") {
                throw new Error(
                    event.error?.message ?? "Terminal stream was cancelled.",
                );
            }
        }
    }

    #acceptOperation(event: ClientEvent): void {
        const payload = readRecord(event.payload);
        const clientSeq = readInteger(payload.clientSeq, "clientSeq");
        const identity = this.#requireIdentity();
        const terminalId = readString(payload.terminalId, "terminalId");
        const generation = readInteger(payload.generation, "generation");
        if (
            terminalId !== identity.terminalId ||
            generation !== identity.generation
        ) {
            throw new Error(
                "Terminal acknowledgement identity does not match the active session.",
            );
        }
        const version = readInteger(payload.version, "version");
        this.#writeIdentity({ ...identity, version });
        const pending = this.#pending.get(clientSeq);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(clientSeq);
        pending.resolve();
    }

    #requireIdentity(): StoredTerminalIdentity {
        const identity = this.#readIdentity();
        if (identity === undefined)
            throw new Error("Terminal identity is unavailable.");
        return identity;
    }

    #fail(error: Error, resultUnknown: boolean): void {
        if (this.#exited || this.#closed) return;
        this.#closed = true;
        this.#stream?.close();
        this.#stream = undefined;
        this.#rejectPending(error);
        this.#emitData(
            `\r\nTerminal connection failed${resultUnknown ? "; an in-flight operation result is unknown" : ""}: ${error.message}\r\n`,
        );
        this.#emitExit({ exitCode: 1 });
    }

    #rejectPending(error: Error): void {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
    }

    #emitData(data: string): void {
        for (const listener of [...this.#dataListeners]) listener(data);
    }

    #emitExit(exit: { exitCode: number; signal?: number }): void {
        if (this.#exited) return;
        this.#exited = true;
        for (const listener of [...this.#exitListeners]) listener(exit);
    }
}

function readSession(event: ClientEvent): TerminalSessionDescriptor {
    const payload = readRecord(event.payload);
    return payload.session as unknown as TerminalSessionDescriptor;
}

function readCompletedSession(event: ClientEvent): TerminalSessionDescriptor {
    const payload = readRecord(event.payload);
    return {
        cols: readInteger(payload.cols, "cols"),
        createdAt: readString(payload.createdAt, "createdAt"),
        generation: readInteger(payload.generation, "generation"),
        instance: readString(payload.instance, "instance"),
        latestSeq: readInteger(payload.latestSeq, "latestSeq"),
        rows: readInteger(payload.rows, "rows"),
        state: readTerminalState(payload.state),
        terminalId: readString(payload.terminalId, "terminalId"),
        version: readInteger(payload.version, "version"),
    };
}

function readOutput(event: ClientEvent): { data: string; seq: number } {
    const payload = readRecord(event.payload);
    return {
        data: readString(payload.data, "data"),
        seq: readInteger(payload.seq, "seq"),
    };
}

function readExit(event: ClientEvent): { exitCode: number; signal?: number } {
    const payload = readRecord(event.payload);
    const signal = payload.signal;
    return {
        exitCode: readInteger(payload.exitCode, "exitCode"),
        ...(typeof signal === "number" ? { signal } : {}),
    };
}

function readRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Terminal event payload must be an object.");
    }
    return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
    if (typeof value !== "string")
        throw new Error(`Terminal ${field} must be a string.`);
    return value;
}

function readInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`Terminal ${field} must be a safe integer.`);
    }
    return value;
}

function readTerminalState(
    value: unknown,
): TerminalSessionDescriptor["state"] {
    if (
        value !== "running" &&
        value !== "exited" &&
        value !== "failed" &&
        value !== "killed"
    ) {
        throw new Error("Terminal state is invalid.");
    }
    return value;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
