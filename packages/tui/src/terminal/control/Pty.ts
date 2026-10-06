import type {
    TerminalAttachment,
    TerminalSessionDescriptor,
    TerminalStreamMessage,
    TerminalTransport,
    TerminalVersionedIdentity,
} from "@portable-devshell/shared";

import type {
    TuiTerminalDisposable,
    TuiTerminalPty,
    TuiTerminalPtyFactory,
    TuiTerminalPtyOptions,
} from "../emulation/Model.js";

const OPERATION_ACK_TIMEOUT_MS = 30_000;

export type TuiControlTerminalClient = Pick<
    TerminalTransport,
    "attach" | "kill" | "open"
>;

interface StoredTerminalIdentity extends TerminalSessionDescriptor {}

interface PendingOperation {
    reject(error: Error): void;
    resolve(): void;
    timer: ReturnType<typeof setTimeout>;
}

export class TuiControlTerminalPtyFactory {
    readonly #client: (instance: string) => TuiControlTerminalClient;
    readonly #operationAckTimeoutMs: number;
    readonly #workspaceForInstance: (instance: string) => string;
    readonly #sessions = new Map<string, StoredTerminalIdentity>();

    constructor(options: {
        client(instance: string): TuiControlTerminalClient;
        operationAckTimeoutMs?: number;
        workspaceForInstance(instance: string): string;
    }) {
        this.#client = options.client;
        this.#workspaceForInstance = options.workspaceForInstance;
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
                client: this.#client(targetInstance),
                operationAckTimeoutMs: this.#operationAckTimeoutMs,
                options,
                readIdentity: () => this.#sessions.get(targetInstance),
                workspace: this.#workspaceForInstance(targetInstance),
                writeIdentity: (identity) =>
                    this.#sessions.set(targetInstance, identity),
            });
        };
    }

    async kill(
        instance: string,
    ): Promise<TerminalSessionDescriptor | undefined> {
        const identity = this.#sessions.get(instance);
        if (identity === undefined || identity.state !== "running") {
            return undefined;
        }
        const killed = await this.#client(instance).kill({
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
    readonly #operationAckTimeoutMs: number;
    readonly #options: TuiTerminalPtyOptions;
    readonly #workspace: string;
    readonly #pending = new Map<number, PendingOperation>();
    readonly #readIdentity: () => StoredTerminalIdentity | undefined;
    readonly #writeIdentity: (identity: StoredTerminalIdentity) => void;
    readonly #ready: Promise<void>;
    #clientSeq = 0;
    #closed = false;
    #exited = false;
    #operationTail = Promise.resolve();
    #stream?: TerminalAttachment;

    constructor(options: {
        client: TuiControlTerminalClient;
        operationAckTimeoutMs: number;
        options: TuiTerminalPtyOptions;
        readIdentity(): StoredTerminalIdentity | undefined;
        workspace: string;
        writeIdentity(identity: StoredTerminalIdentity): void;
    }) {
        this.#client = options.client;
        this.#operationAckTimeoutMs = options.operationAckTimeoutMs;
        this.#options = options.options;
        this.#workspace = options.workspace;
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
            identity = await this.#client.open({
                cols: this.#options.columns,
                rows: this.#options.rows,
                workspace: this.#workspace,
            });
            this.#writeIdentity({ ...identity });
        }
        // Every TUI attachment creates a fresh local terminal buffer. Replay
        // durable server output from the beginning so reopening the terminal
        // restores the screen instead of resuming after unseen output.
        const fromSeq = 0;
        const stream = await this.#client.attach({
            fromSeq,
            generation: identity.generation,
            terminalId: identity.terminalId,
        });
        if (this.#closed) {
            stream.close();
            return;
        }
        const seed = await stream.next();
        if (seed.kind !== "seed")
            throw new Error("Terminal stream seed is missing.");
        const acknowledged = seed.session;
        this.#writeIdentity({ ...acknowledged, latestSeq: fromSeq });
        this.#stream = stream;
        void this.#consume(stream).catch((error: unknown) => {
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
                const command = {
                    clientSeq,
                    generation: identity.generation,
                    terminalId: identity.terminalId,
                    version: identity.version,
                };
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
                    if (operation === "input") {
                        await stream.sendInput(
                            (payload as { data: string }).data,
                            command,
                        );
                    } else {
                        const resize = payload as { cols: number; rows: number };
                        await stream.sendResize(
                            resize.cols,
                            resize.rows,
                            command,
                        );
                    }
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

    async #consume(stream: TerminalAttachment): Promise<void> {
        while (!this.#closed && this.#stream === stream) {
            const next = await stream.next();
            if (next.kind === "closed") {
                if (next.session !== undefined)
                    this.#writeIdentity(next.session);
                this.#stream = undefined;
                if (next.error !== undefined) throw next.error;
                return;
            }
            if (next.kind === "output") {
                const frame = next.frame;
                const identity = this.#requireIdentity();
                if (frame.seq <= identity.latestSeq) continue;
                if (frame.seq !== identity.latestSeq + 1)
                    throw new Error(
                        `Terminal output gap: expected ${identity.latestSeq + 1}, received ${frame.seq}.`,
                    );
                const updated = { ...identity, latestSeq: frame.seq };
                this.#writeIdentity(updated);
                this.#emitData(frame.data);
                await stream.ack(updated, frame.seq);
                continue;
            }
            if (
                next.kind === "inputAccepted" ||
                next.kind === "resized"
            ) {
                this.#acceptOperation(next);
                continue;
            }
            if (next.kind === "exit") {
                const identity = this.#requireIdentity();
                this.#writeIdentity({ ...identity, state: "exited" });
                this.#emitExit(next.event);
            }
        }
    }

    #acceptOperation(
        event: Extract<
            TerminalStreamMessage,
            { kind: "inputAccepted" | "resized" }
        >,
    ): void {
        const clientSeq = event.clientSeq;
        const identity = this.#requireIdentity();
        if (
            event.identity.terminalId !== identity.terminalId ||
            event.identity.generation !== identity.generation
        ) {
            throw new Error(
                "Terminal acknowledgement identity does not match the active session.",
            );
        }
        this.#writeIdentity({ ...identity, version: event.identity.version });
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

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
