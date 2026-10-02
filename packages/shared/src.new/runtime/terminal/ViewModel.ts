// Stateful terminal projection. Owns the session descriptor, ordered output
// with acknowledgement, input/resize acknowledgement, exit handling, and
// reconnect with replay from latestSeq + 1. Output is delivered through
// listeners because it is high frequency and must not be buffered in state.

import type {
    TerminalExitEvent,
    TerminalOpenInput,
    TerminalSessionDescriptor,
    TerminalStreamCommandIdentity,
    TerminalVersionedIdentity,
} from "./Model.js";
import type { TerminalAttachment, TerminalTransport } from "./Transport.js";

const DEFAULT_OPERATION_ACK_TIMEOUT_MS = 30_000;

export type TerminalStatus =
    | "idle"
    | "connecting"
    | "live"
    | "reconnecting"
    | "exited"
    | "failed"
    | "closed";

export interface TerminalViewModelState {
    failure?: Error;
    identity?: TerminalSessionDescriptor;
    latestSeq: number;
    status: TerminalStatus;
}

export interface TerminalViewModelOptions {
    operationAckTimeoutMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
}

export class TerminalViewModel {
    readonly #dataListeners = new Set<(data: string) => void>();
    readonly #exitListeners = new Set<(event: TerminalExitEvent) => void>();
    readonly #listeners = new Set<() => void>();
    readonly #operationAckTimeoutMs: number;
    readonly #retryBaseMs: number;
    readonly #retryMaxMs: number;
    readonly #transport: TerminalTransport;
    #attachment?: TerminalAttachment;
    #attempt = 0;
    #clientSeq = 0;
    #generation = 0;
    #identity?: TerminalSessionDescriptor;
    #input?: TerminalOpenInput;
    #instance?: string;
    #operationTail: Promise<void> = Promise.resolve();
    readonly #pending = new Map<
        number,
        {
            reject(error: Error): void;
            resolve(): void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    #published: TerminalViewModelState = emptyState();
    #reconnectTimer?: ReturnType<typeof setTimeout>;
    #state: TerminalViewModelState = emptyState();

    constructor(
        transport: TerminalTransport,
        options: TerminalViewModelOptions = {},
    ) {
        this.#transport = transport;
        this.#operationAckTimeoutMs =
            options.operationAckTimeoutMs ?? DEFAULT_OPERATION_ACK_TIMEOUT_MS;
        this.#retryBaseMs = options.retryBaseMs ?? 500;
        this.#retryMaxMs = options.retryMaxMs ?? 15_000;
    }

    get state(): Readonly<TerminalViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    onData(listener: (data: string) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    onExit(listener: (event: TerminalExitEvent) => void): () => void {
        this.#exitListeners.add(listener);
        return () => this.#exitListeners.delete(listener);
    }

    async open(
        instance: string,
        input: TerminalOpenInput,
    ): Promise<TerminalSessionDescriptor> {
        this.#instance = instance;
        this.#input = input;
        const generation = ++this.#generation;
        await this.#connect(generation, 0);
        return this.#requireIdentity();
    }

    write(data: string): void {
        this.#enqueueOperation(async (attachment) => {
            const clientSeq = ++this.#clientSeq;
            await this.#awaitAck(clientSeq, () =>
                attachment.sendInput(data, this.#command(clientSeq)),
            );
        });
    }

    resize(cols: number, rows: number): void {
        this.#enqueueOperation(async (attachment) => {
            const clientSeq = ++this.#clientSeq;
            await this.#awaitAck(clientSeq, () =>
                attachment.sendResize(cols, rows, this.#command(clientSeq)),
            );
        });
    }

    async kill(): Promise<TerminalSessionDescriptor | undefined> {
        const instance = this.#requireInstance();
        const identity = this.#identity;
        if (identity === undefined || identity.state !== "running")
            return undefined;
        const killed = await this.#transport.kill(instance, {
            generation: identity.generation,
            terminalId: identity.terminalId,
            version: identity.version,
        });
        this.#applyIdentity({ ...killed });
        this.#closeAttachment();
        this.#setStatus("exited");
        return killed;
    }

    close(): void {
        this.#generation += 1;
        this.#instance = undefined;
        this.#input = undefined;
        if (this.#reconnectTimer !== undefined) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = undefined;
        }
        this.#rejectPending(new Error("Terminal view model closed."));
        this.#closeAttachment();
        this.#listeners.clear();
        this.#dataListeners.clear();
        this.#exitListeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    async #connect(generation: number, fromSeq: number): Promise<void> {
        const instance = this.#requireInstance();
        this.#setStatus(fromSeq === 0 ? "connecting" : "reconnecting");
        let identity = this.#identity;
        if (identity === undefined || identity.state !== "running") {
            identity = await this.#transport.open(instance, this.#requireInput());
            if (generation !== this.#generation) return;
            this.#applyIdentity({ ...identity, latestSeq: fromSeq });
        }
        const attachment = await this.#transport.attach(instance, {
            fromSeq,
            generation: identity.generation,
            terminalId: identity.terminalId,
        });
        if (generation !== this.#generation) {
            attachment.close();
            return;
        }
        while (generation === this.#generation) {
            const message = await attachment.next();
            if (generation !== this.#generation) {
                attachment.close();
                return;
            }
            if (message.kind === "seed") {
                this.#attachment = attachment;
                this.#applyIdentity({
                    ...message.session,
                    latestSeq:
                        this.#identity?.latestSeq ?? message.session.latestSeq,
                });
                this.#attempt = 0;
                this.#setStatus("live");
                void this.#consume(generation, attachment).catch(
                    (error: unknown) => {
                        if (generation !== this.#generation) return;
                        this.#state = {
                            ...this.#state,
                            failure: toError(error),
                        };
                        this.#setStatus("failed");
                    },
                );
                return;
            }
            if (message.kind === "closed") {
                this.#onClosed(generation);
                return;
            }
        }
    }

    async #consume(
        generation: number,
        attachment: TerminalAttachment,
    ): Promise<void> {
        while (
            generation === this.#generation &&
            this.#attachment === attachment
        ) {
            const message = await attachment.next();
            if (
                generation !== this.#generation ||
                this.#attachment !== attachment
            )
                return;
            if (message.kind === "output") {
                await this.#acceptOutput(attachment, message.frame);
                continue;
            }
            if (
                message.kind === "inputAccepted" ||
                message.kind === "resized"
            ) {
                this.#acceptOperation(message.clientSeq, message.identity);
                continue;
            }
            if (message.kind === "exit") {
                this.#applyIdentity({
                    ...this.#requireIdentity(),
                    state: "exited",
                });
                this.#setStatus("exited");
                for (const listener of [...this.#exitListeners])
                    listener(message.event);
                this.#closeAttachment();
                return;
            }
            this.#onClosed(generation);
            return;
        }
    }

    async #acceptOutput(
        attachment: TerminalAttachment,
        frame: { data: string; seq: number },
    ): Promise<void> {
        const identity = this.#requireIdentity();
        if (frame.seq <= identity.latestSeq) return;
        if (frame.seq !== identity.latestSeq + 1) {
            this.#onClosed(this.#generation);
            return;
        }
        const updated = { ...identity, latestSeq: frame.seq };
        this.#applyIdentity(updated);
        for (const listener of [...this.#dataListeners]) listener(frame.data);
        await attachment.ack(
            {
                generation: updated.generation,
                terminalId: updated.terminalId,
                version: updated.version,
            },
            frame.seq,
        );
    }

    #acceptOperation(
        clientSeq: number,
        identity: TerminalVersionedIdentity,
    ): void {
        const current = this.#requireIdentity();
        if (
            identity.terminalId !== current.terminalId ||
            identity.generation !== current.generation
        )
            throw new Error(
                "Terminal acknowledgement identity does not match the active session.",
            );
        this.#applyIdentity({ ...current, version: identity.version });
        const pending = this.#pending.get(clientSeq);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(clientSeq);
        pending.resolve();
    }

    #onClosed(generation: number): void {
        this.#closeAttachment();
        if (generation !== this.#generation) return;
        const identity = this.#identity;
        if (identity === undefined || identity.state !== "running") {
            this.#state = {
                ...this.#state,
                failure: new Error("Terminal session is no longer running."),
            };
            this.#setStatus("failed");
            return;
        }
        this.#scheduleReconnect(generation);
    }

    #scheduleReconnect(generation: number): void {
        if (this.#reconnectTimer !== undefined) return;
        this.#setStatus("reconnecting");
        const delay = Math.min(
            this.#retryBaseMs * 2 ** this.#attempt,
            this.#retryMaxMs,
        );
        this.#attempt += 1;
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = undefined;
            if (generation !== this.#generation) return;
            void this.#connect(
                generation,
                this.#requireIdentity().latestSeq + 1,
            ).catch((error: unknown) => {
                if (generation !== this.#generation) return;
                this.#state = { ...this.#state, failure: toError(error) };
                this.#setStatus("failed");
            });
        }, delay);
    }

    #enqueueOperation(
        operation: (attachment: TerminalAttachment) => Promise<void>,
    ): void {
        this.#operationTail = this.#operationTail
            .then(async () => {
                const attachment = this.#attachment;
                const identity = this.#identity;
                if (
                    attachment === undefined ||
                    identity === undefined ||
                    identity.state !== "running"
                )
                    throw new Error("Terminal attachment is not ready.");
                await operation(attachment);
            })
            .catch((error: unknown) => {
                this.#state = { ...this.#state, failure: toError(error) };
                this.#emit();
            });
    }

    async #awaitAck(
        clientSeq: number,
        send: () => Promise<void>,
    ): Promise<void> {
        const acknowledged = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(clientSeq);
                reject(
                    new Error(
                        `Terminal operation ${clientSeq} result is unknown because no acknowledgement was received.`,
                    ),
                );
            }, this.#operationAckTimeoutMs);
            this.#pending.set(clientSeq, { reject, resolve, timer });
        });
        try {
            await send();
            await acknowledged;
        } catch (error) {
            const pending = this.#pending.get(clientSeq);
            if (pending !== undefined) {
                clearTimeout(pending.timer);
                this.#pending.delete(clientSeq);
            }
            throw error;
        }
    }

    #command(clientSeq: number): TerminalStreamCommandIdentity {
        const identity = this.#requireIdentity();
        return {
            clientSeq,
            generation: identity.generation,
            terminalId: identity.terminalId,
            version: identity.version,
        };
    }

    #rejectPending(error: Error): void {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
    }

    #applyIdentity(identity: TerminalSessionDescriptor): void {
        this.#identity = identity;
        this.#state = {
            ...this.#state,
            identity,
            latestSeq: identity.latestSeq,
        };
        this.#emit();
    }

    #closeAttachment(): void {
        const attachment = this.#attachment;
        this.#attachment = undefined;
        attachment?.close();
    }

    #setStatus(status: TerminalStatus): void {
        this.#state = { ...this.#state, status };
        this.#emit();
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }

    #requireIdentity(): TerminalSessionDescriptor {
        if (this.#identity === undefined)
            throw new Error("Terminal view model is not open.");
        return this.#identity;
    }

    #requireInput(): TerminalOpenInput {
        if (this.#input === undefined)
            throw new Error("Terminal view model is not open.");
        return this.#input;
    }

    #requireInstance(): string {
        if (this.#instance === undefined)
            throw new Error("Terminal view model is not open.");
        return this.#instance;
    }
}

function emptyState(): TerminalViewModelState {
    return { latestSeq: 0, status: "idle" };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
