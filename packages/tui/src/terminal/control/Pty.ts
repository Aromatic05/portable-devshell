import {
    STREAM_GAP_CODE,
    type TerminalAttachment,
    type TerminalSessionDescriptor,
    type TerminalStreamMessage,
    type TerminalTransport,
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
> &
    Partial<Pick<TerminalTransport, "list">>;

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

    readonly #activePtys = new Map<string, TuiControlTerminalPty>();

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
        return (command, args, options) => {
            const targetInstance = instance ?? command;
            const terminalId = args[0];
            const takeover = args[1] !== "observe";
            const key =
                terminalId === undefined
                    ? targetInstance
                    : `${targetInstance}:${terminalId}`;
            const pty = new TuiControlTerminalPty({
                client: this.#client(targetInstance),
                onDispose: () => {
                    if (this.#activePtys.get(key) === pty)
                        this.#activePtys.delete(key);
                },
                operationAckTimeoutMs: this.#operationAckTimeoutMs,
                options,
                readIdentity: () => this.#sessions.get(key),
                takeover,
                terminalId,
                workspace: this.#workspaceForInstance(targetInstance),
                writeIdentity: (identity) => this.#sessions.set(key, identity),
            });
            this.#activePtys.set(key, pty);
            return pty;
        };
    }

    async setControl(
        instance: string,
        terminalId: string,
        takeover: boolean,
    ): Promise<void> {
        const pty = this.#activePtys.get(`${instance}:${terminalId}`);
        if (pty === undefined)
            throw new Error("Selected terminal is not attached.");
        await pty.setControl(takeover);
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
    readonly #onDispose?: () => void;
    readonly #operationAckTimeoutMs: number;
    readonly #options: TuiTerminalPtyOptions;
    readonly #workspace: string;
    readonly #pending = new Map<number, PendingOperation>();
    readonly #readIdentity: () => StoredTerminalIdentity | undefined;
    readonly #writeIdentity: (identity: StoredTerminalIdentity) => void;
    readonly #ready: Promise<void>;
    readonly #terminalId?: string;
    #clientSeq = 0;
    #closed = false;
    #exited = false;
    #operationTail = Promise.resolve();
    #stream?: TerminalAttachment;
    #takeover: boolean;

    constructor(options: {
        client: TuiControlTerminalClient;
        onDispose?(): void;
        operationAckTimeoutMs: number;
        options: TuiTerminalPtyOptions;
        readIdentity(): StoredTerminalIdentity | undefined;
        takeover: boolean;
        terminalId?: string;
        workspace: string;
        writeIdentity(identity: StoredTerminalIdentity): void;
    }) {
        this.#client = options.client;
        this.#onDispose = options.onDispose;
        this.#operationAckTimeoutMs = options.operationAckTimeoutMs;
        this.#options = options.options;
        this.#workspace = options.workspace;
        this.#readIdentity = options.readIdentity;
        this.#takeover = options.takeover;
        this.#terminalId = options.terminalId;
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
        this.#onDispose?.();
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
        if (!this.#takeover) return;
        this.#enqueueOperation("resize", { cols: columns, rows });
    }

    write(data: string): void {
        if (!this.#takeover) return;
        this.#enqueueOperation("input", { data });
    }

    async setControl(takeover: boolean): Promise<void> {
        await this.#ready;
        if (this.#closed) throw new Error("Terminal attachment is closed.");
        if (this.#takeover === takeover) return;
        const stream = this.#stream;
        const identity = this.#readIdentity();
        if (
            stream === undefined ||
            identity === undefined ||
            stream.sendControl === undefined
        ) {
            throw new Error("Terminal control toggle is unavailable.");
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
                        "Terminal control change timed out before acknowledgement.",
                    ),
                );
            }, this.#operationAckTimeoutMs);
            timer.unref?.();
            this.#pending.set(clientSeq, { reject, resolve, timer });
        });
        try {
            await stream.sendControl(takeover, command);
            await acknowledged;
            this.#takeover = takeover;
        } catch (error) {
            const pending = this.#pending.get(clientSeq);
            if (pending !== undefined) {
                clearTimeout(pending.timer);
                this.#pending.delete(clientSeq);
                pending.reject(asError(error));
            }
            throw error;
        }
    }

    async #connect(): Promise<void> {
        let identity = this.#readIdentity();
        if (this.#terminalId !== undefined) {
            identity = (await this.#client.list?.())?.find(
                (session) =>
                    session.terminalId === this.#terminalId &&
                    session.state === "running",
            );
            if (identity === undefined)
                throw new Error("Selected terminal is not running.");
            this.#writeIdentity(identity);
        }
        if (identity === undefined || identity.state !== "running") {
            identity = await this.#client.open({
                cols: this.#options.columns,
                rows: this.#options.rows,
                workspace: this.#workspace,
            });
            this.#writeIdentity({ ...identity });
        }
        await this.#attachStream(identity);
    }

    async #attachStream(identity: StoredTerminalIdentity): Promise<void> {
        // Every TUI attachment creates a fresh local terminal buffer. Replay
        // durable server output from the beginning so reopening the terminal
        // restores the screen instead of resuming after unseen output.
        const fromSeq = 0;
        const stream = await this.#client.attach({
            fromSeq,
            ...(this.#takeover ? { takeover: true } : {}),
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
        this.#writeIdentity({
            ...acknowledged,
            latestSeq: seed.snapshot?.seq ?? fromSeq,
        });
        if (seed.snapshot !== undefined) {
            for (const listener of this.#dataListeners)
                listener(seed.snapshot.data);
        }
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
                        const resize = payload as {
                            cols: number;
                            rows: number;
                        };
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
                if (
                    next.error !== undefined &&
                    isStreamGapError(next.error) &&
                    this.#pending.size === 0
                ) {
                    const identity = this.#readIdentity();
                    if (identity !== undefined && identity.state === "running") {
                        await this.#attachStream(identity);
                        return;
                    }
                }
                if (next.error !== undefined) throw next.error;
                return;
            }
            if (next.kind === "output") {
                const frame = next.frame;
                const identity = this.#requireIdentity();
                if (frame.seq <= identity.latestSeq) continue;
                if (frame.seq !== identity.latestSeq + 1) {
                    if (this.#pending.size === 0) {
                        stream.close();
                        this.#stream = undefined;
                        await this.#attachStream(identity);
                        return;
                    }
                    throw new Error(
                        `Terminal output gap: expected ${identity.latestSeq + 1}, received ${frame.seq}.`,
                    );
                }
                const updated = { ...identity, latestSeq: frame.seq };
                this.#writeIdentity(updated);
                this.#emitData(frame.data);
                await stream.ack(updated, frame.seq);
                continue;
            }
            if (next.kind === "inputAccepted" || next.kind === "resized") {
                this.#acceptOperation(next);
                continue;
            }
            if (next.kind === "controlChanged") {
                const identity = this.#requireIdentity();
                const updated: StoredTerminalIdentity = {
                    ...next.session,
                    latestSeq: Math.max(
                        identity.latestSeq,
                        next.snapshot?.seq ?? identity.latestSeq,
                    ),
                };
                this.#writeIdentity(updated);
                if (next.error !== undefined) {
                    const pending = this.#pending.get(next.clientSeq);
                    if (pending !== undefined) {
                        clearTimeout(pending.timer);
                        this.#pending.delete(next.clientSeq);
                        pending.reject(new Error(next.error));
                    }
                    continue;
                }
                if (next.snapshot !== undefined) {
                    this.#emitData(next.snapshot.data);
                }
                const pending = this.#pending.get(next.clientSeq);
                if (pending !== undefined) {
                    clearTimeout(pending.timer);
                    this.#pending.delete(next.clientSeq);
                    pending.resolve();
                }
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

function isStreamGapError(error: Error): boolean {
    return (
        "code" in error &&
        (error as { code?: unknown }).code === STREAM_GAP_CODE
    );
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
