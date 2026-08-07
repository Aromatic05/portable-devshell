import { StringDecoder } from "node:string_decoder";

import type { WorkerInstance, WorkerTerminalDescriptor, WorkerTerminalIdentity, WorkerTerminalNotification } from "@portable-devshell/core";

import type {
    TerminalBackend,
    TerminalBackendOpenInput,
    TerminalBackendOpenResult,
    TerminalBackendSession,
    TerminalProcess,
    TerminalProcessExit,
} from "./TerminalProcess.js";

export type WorkerTerminalPort = Pick<
    WorkerInstance,
    | "attachTerminal"
    | "killTerminal"
    | "listTerminals"
    | "onRpcConnected"
    | "onRpcDisconnected"
    | "onTerminalNotification"
    | "openTerminal"
    | "resizeTerminal"
    | "writeTerminal"
>;

export class WorkerTerminalBackend implements TerminalBackend {
    constructor(private readonly options: { worker: WorkerTerminalPort }) {}

    async open(input: TerminalBackendOpenInput): Promise<TerminalBackendOpenResult> {
        const descriptor = await this.options.worker.openTerminal({
            cols: input.cols,
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            rows: input.rows,
        });
        const process = new WorkerTerminalProcess(this.options.worker, descriptor);
        await process.initialize();
        return {
            identity: remoteIdentity(descriptor),
            process,
        };
    }

    async recover(): Promise<TerminalBackendSession[]> {
        const descriptors = (await this.options.worker.listTerminals())
            .filter((descriptor) => descriptor.state === "running");
        return await Promise.all(descriptors.map(async (descriptor) => {
            const process = new WorkerTerminalProcess(this.options.worker, descriptor);
            await process.initialize();
            return { identity: remoteIdentity(descriptor), process };
        }));
    }
}

class WorkerTerminalProcess implements TerminalProcess {
    readonly #dataListeners = new Set<(data: string, sourceSeq?: number) => void>();
    readonly #errorListeners = new Set<(error: Error) => void>();
    readonly #exitListeners = new Set<(exit: TerminalProcessExit) => void>();
    readonly #decoder = new StringDecoder("utf8");
    readonly #pendingData: Array<{ data: string; seq: number }> = [];
    readonly #unsubscribeConnected: () => void;
    readonly #unsubscribeDisconnected: () => void;
    readonly #unsubscribeNotification: () => void;
    readonly #worker: WorkerTerminalPort;
    #clientSeq = 0;
    #closed = false;
    #descriptor: WorkerTerminalDescriptor;
    #lastSeq = 0;
    #operationTail = Promise.resolve();
    #resumeTail = Promise.resolve();

    constructor(
        worker: WorkerTerminalPort,
        descriptor: WorkerTerminalDescriptor,
    ) {
        this.#worker = worker;
        this.#descriptor = descriptor;
        this.#unsubscribeNotification = worker.onTerminalNotification((notification) => {
            this.#acceptNotification(notification);
        });
        this.#unsubscribeConnected = worker.onRpcConnected(() => {
            if (!this.#closed) this.#scheduleResume();
        });
        this.#unsubscribeDisconnected = worker.onRpcDisconnected(() => {
            // The remote PTY remains owned by the worker process. Reattach after the
            // next authenticated reverse channel activation instead of fabricating exit.
        });
    }

    async initialize(): Promise<void> {
        await this.#resume();
    }

    dispose(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#disposeSubscriptions();
    }

    async kill(): Promise<void> {
        await this.#serialize(async () => {
            const result = await this.#worker.killTerminal(this.#identity());
            this.#acceptOperationIdentity(result);
            if (result.version >= this.#descriptor.version) {
                this.#descriptor = result;
            }
        });
    }

    onData(listener: (data: string, sourceSeq?: number) => void): () => void {
        this.#dataListeners.add(listener);
        for (const frame of this.#pendingData.splice(0)) listener(frame.data, frame.seq);
        return () => this.#dataListeners.delete(listener);
    }

    onError(listener: (error: Error) => void): () => void {
        this.#errorListeners.add(listener);
        return () => this.#errorListeners.delete(listener);
    }

    onExit(listener: (exit: TerminalProcessExit) => void): () => void {
        this.#exitListeners.add(listener);
        if (this.#descriptor.state === "exited") {
            queueMicrotask(() => listener({ exitCode: 0, signal: 0 }));
        }
        return () => this.#exitListeners.delete(listener);
    }

    async resize(cols: number, rows: number): Promise<void> {
        await this.#serialize(async () => {
            const result = await this.#worker.resizeTerminal({
                ...this.#identity(),
                cols,
                rows,
            });
            if (!result.accepted) throw new Error("Remote terminal resize was not accepted.");
            this.#acceptOperationIdentity(result);
            if (result.version >= this.#descriptor.version) {
                this.#descriptor = {
                    ...this.#descriptor,
                    cols,
                    rows,
                    version: result.version,
                };
            }
        });
    }

    async write(data: string): Promise<void> {
        await this.#serialize(async () => {
            const result = await this.#worker.writeTerminal({
                ...this.#identity(),
                data: Buffer.from(data, "utf8").toString("base64"),
            });
            if (!result.accepted) throw new Error("Remote terminal input was not accepted.");
            this.#acceptOperationIdentity(result);
            if (result.version >= this.#descriptor.version) {
                this.#descriptor = { ...this.#descriptor, version: result.version };
            }
        });
    }

    #identity(): WorkerTerminalIdentity {
        return {
            clientSeq: ++this.#clientSeq,
            generation: this.#descriptor.generation,
            terminalId: this.#descriptor.terminalId,
            version: this.#descriptor.version,
        };
    }

    #acceptOperationIdentity(identity: WorkerTerminalIdentity): void {
        if (
            identity.terminalId !== this.#descriptor.terminalId ||
            identity.generation !== this.#descriptor.generation
        ) {
            throw new Error("Remote terminal operation identity changed.");
        }
    }

    async #serialize(operation: () => Promise<void>): Promise<void> {
        const current = this.#operationTail.then(operation);
        this.#operationTail = current.catch(() => undefined);
        await current;
    }

    #scheduleResume(): void {
        const current = this.#resumeTail.then(async () => {
            await this.#serialize(async () => {
                await this.#resume();
            });
        });
        this.#resumeTail = current.catch((error: unknown) => {
            this.#fail(asError(error));
        });
    }

    async #resume(): Promise<void> {
        if (this.#closed) return;
        const attached = await this.#worker.attachTerminal({
            fromSeq: this.#lastSeq,
            generation: this.#descriptor.generation,
            terminalId: this.#descriptor.terminalId,
        });
        if (this.#closed) return;
        if (
            attached.session.terminalId !== this.#descriptor.terminalId ||
            attached.session.generation !== this.#descriptor.generation
        ) {
            throw new Error("Remote terminal attachment identity changed.");
        }
        this.#descriptor = attached.session;
        for (const frame of attached.replay) this.#acceptOutput(frame.seq, frame.dataBase64);
        if (attached.exit !== undefined) {
            this.#acceptExit({
                exitCode: attached.exit.exitCode,
                signal: attached.exit.signal,
            }, attached.session.version);
        }
    }

    #acceptNotification(notification: WorkerTerminalNotification): void {
        if (
            notification.params.terminalId !== this.#descriptor.terminalId ||
            notification.params.generation !== this.#descriptor.generation ||
            this.#closed
        ) {
            return;
        }
        if (notification.method === "terminal.output") {
            if (notification.params.seq > this.#lastSeq + 1) {
                this.#scheduleResume();
                return;
            }
            this.#acceptOutput(notification.params.seq, notification.params.dataBase64);
            return;
        }
        this.#acceptExit(
            {
                exitCode: notification.params.exitCode,
                signal: notification.params.signal,
            },
            notification.params.version,
        );
    }

    #acceptOutput(seq: number, dataBase64: string): void {
        if (seq <= this.#lastSeq) return;
        if (seq !== this.#lastSeq + 1) {
            throw new Error(
                `Remote terminal output gap: expected ${this.#lastSeq + 1}, received ${seq}.`,
            );
        }
        this.#lastSeq = seq;
        this.#descriptor = {
            ...this.#descriptor,
            latestSeq: Math.max(this.#descriptor.latestSeq, seq),
        };
        const decoded = this.#decoder.write(Buffer.from(dataBase64, "base64"));
        this.#emitData(decoded, seq);
    }

    #acceptExit(exit: TerminalProcessExit, version: number): void {
        if (this.#closed) return;
        const finalText = this.#decoder.end();
        if (finalText.length > 0 && this.#lastSeq > 0) {
            this.#emitData(finalText, this.#lastSeq);
        }
        this.#descriptor = { ...this.#descriptor, state: "exited", version };
        this.#closed = true;
        this.#disposeSubscriptions();
        for (const listener of [...this.#exitListeners]) listener(exit);
    }

    #emitData(data: string, seq: number): void {
        if (this.#dataListeners.size === 0) {
            this.#pendingData.push({ data, seq });
            return;
        }
        for (const listener of [...this.#dataListeners]) listener(data, seq);
    }

    #fail(error: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#disposeSubscriptions();
        for (const listener of [...this.#errorListeners]) listener(error);
    }

    #disposeSubscriptions(): void {
        this.#unsubscribeConnected();
        this.#unsubscribeDisconnected();
        this.#unsubscribeNotification();
    }
}

function remoteIdentity(descriptor: WorkerTerminalDescriptor) {
    return {
        cols: descriptor.cols,
        createdAt: new Date(descriptor.createdAtMs).toISOString(),
        recoverable: true,
        rows: descriptor.rows,
        generation: descriptor.generation,
        terminalId: descriptor.terminalId,
        version: descriptor.version,
    };
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
