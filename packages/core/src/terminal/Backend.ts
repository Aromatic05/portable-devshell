import { StringDecoder } from "node:string_decoder";
import type {
    WorkerTerminalPort,
    WorkerTerminalDescriptor,
    WorkerTerminalIdentity,
    WorkerTerminalNotification,
    TerminalBackend,
    TerminalBackendOpenInput,
    TerminalBackendOpenResult,
    TerminalBackendSession,
    TerminalProcess,
    TerminalProcessExit,
    TerminalRestore,
} from "./Api.js";

export class WorkerTerminalBackend implements TerminalBackend {
    constructor(private readonly options: { worker: WorkerTerminalPort }) {}

    async open(
        input: TerminalBackendOpenInput,
    ): Promise<TerminalBackendOpenResult> {
        const descriptor = await this.options.worker.open({
            cols: input.cols,
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            rows: input.rows,
            workspace: input.workspace,
        });
        const process = new WorkerTerminalProcess(
            this.options.worker,
            descriptor,
        );
        await process.initialize();
        return {
            identity: remoteIdentity(descriptor),
            process,
        };
    }

    async recover(
        known?: ReadonlySet<string>,
    ): Promise<TerminalBackendSession[]> {
        const descriptors = (await this.options.worker.list()).filter(
            (descriptor) =>
                descriptor.state === "running" &&
                !known?.has(descriptor.terminalId),
        );
        return await Promise.all(
            descriptors.map(async (descriptor) => {
                const process = new WorkerTerminalProcess(
                    this.options.worker,
                    descriptor,
                );
                await process.initialize();
                return { identity: remoteIdentity(descriptor), process };
            }),
        );
    }
}

class WorkerTerminalProcess implements TerminalProcess {
    readonly #dataListeners = new Set<
        (data: string, sourceSeq?: number) => void
    >();
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
    #exit?: TerminalProcessExit;
    #lastSeq = 0;
    #localSeq = 0;
    #controller?: string;
    #controlHeartbeat?: ReturnType<typeof setInterval>;
    #operationTail = Promise.resolve();
    #resumeTail = Promise.resolve();

    constructor(
        worker: WorkerTerminalPort,
        descriptor: WorkerTerminalDescriptor,
    ) {
        this.#worker = worker;
        this.#descriptor = descriptor;
        this.#unsubscribeNotification = worker.onNotification(
            (notification) => {
                this.#acceptNotification(notification);
            },
        );
        this.#unsubscribeConnected = worker.onConnected(() => {
            if (!this.#closed) this.#scheduleResume();
        });
        this.#unsubscribeDisconnected = worker.onDisconnected(() => {
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
        void this.releaseControl().catch(() => undefined);
    }

    async acquireControl(): Promise<TerminalRestore> {
        let snapshot: TerminalRestore | undefined;
        await this.#serialize(async () => {
            if (this.#worker.control === undefined)
                throw new Error("Worker does not provide terminal control.");
            if (this.#controller !== undefined)
                throw new Error(
                    "Terminal already has a controlling attachment.",
                );
            const result = await this.#worker.control({
                terminalId: this.#descriptor.terminalId,
                generation: this.#descriptor.generation,
            });
            if (
                result.controller === undefined ||
                result.snapshot === undefined ||
                result.session === undefined
            ) {
                throw new Error(
                    "Worker returned incomplete terminal control state.",
                );
            }
            this.#controller = result.controller;
            this.#startControlHeartbeat();
            this.#descriptor = result.session;
            try {
                if (result.snapshot.seq > this.#lastSeq) await this.#resume();
                const seq =
                    this.#localSeq - (this.#lastSeq - result.snapshot.seq);
                if (seq < 0 || result.snapshot.seq > this.#lastSeq)
                    throw new Error(
                        "Terminal control snapshot is outside the output boundary.",
                    );
                snapshot = { seq, data: result.snapshot.data };
            } catch (error) {
                await this.#releaseControl();
                throw error;
            }
        });
        if (snapshot === undefined)
            throw new Error("Terminal control snapshot is missing.");
        return snapshot;
    }

    async releaseControl(): Promise<void> {
        await this.#serialize(async () => await this.#releaseControl());
    }

    #startControlHeartbeat(): void {
        clearInterval(this.#controlHeartbeat);
        this.#controlHeartbeat = setInterval(() => {
            const controller = this.#controller;
            if (controller === undefined || this.#worker.control === undefined)
                return;
            void this.#worker
                .control({
                    terminalId: this.#descriptor.terminalId,
                    generation: this.#descriptor.generation,
                    controller,
                    renew: true,
                })
                .catch((error: unknown) => {
                    if (this.#controller === controller)
                        this.#fail(asError(error));
                });
        }, 10_000);
        this.#controlHeartbeat.unref?.();
    }

    async #releaseControl(): Promise<void> {
        clearInterval(this.#controlHeartbeat);
        this.#controlHeartbeat = undefined;
        const controller = this.#controller;
        if (controller === undefined || this.#worker.control === undefined)
            return;
        await this.#worker.control({
            terminalId: this.#descriptor.terminalId,
            generation: this.#descriptor.generation,
            controller,
        });
        if (this.#controller === controller) this.#controller = undefined;
    }

    async kill(): Promise<void> {
        await this.#serialize(async () => {
            const result = await this.#worker.kill(this.#identity());
            this.#acceptOperationIdentity(result);
            if (result.version >= this.#descriptor.version) {
                this.#descriptor = result;
            }
        });
    }

    onData(listener: (data: string, sourceSeq?: number) => void): () => void {
        this.#dataListeners.add(listener);
        for (const frame of this.#pendingData.splice(0))
            listener(frame.data, frame.seq);
        return () => this.#dataListeners.delete(listener);
    }

    onError(listener: (error: Error) => void): () => void {
        this.#errorListeners.add(listener);
        return () => this.#errorListeners.delete(listener);
    }

    onExit(listener: (exit: TerminalProcessExit) => void): () => void {
        this.#exitListeners.add(listener);
        if (this.#exit !== undefined) {
            const exit = this.#exit;
            queueMicrotask(() => listener(exit));
        }
        return () => this.#exitListeners.delete(listener);
    }

    async resize(cols: number, rows: number): Promise<void> {
        await this.#serialize(async () => {
            const result = await this.#worker.resize({
                ...this.#identity(),
                cols,
                rows,
            });
            if (!result.accepted)
                throw new Error("Remote terminal resize was not accepted.");
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
            const result = await this.#worker.write({
                ...this.#identity(),
                data: Buffer.from(data, "utf8").toString("base64"),
            });
            if (!result.accepted)
                throw new Error("Remote terminal input was not accepted.");
            this.#acceptOperationIdentity(result);
            if (result.version >= this.#descriptor.version) {
                this.#descriptor = {
                    ...this.#descriptor,
                    version: result.version,
                };
            }
        });
    }

    #identity(): WorkerTerminalIdentity {
        return {
            clientSeq: ++this.#clientSeq,
            generation: this.#descriptor.generation,
            terminalId: this.#descriptor.terminalId,
            version: this.#descriptor.version,
            ...(this.#controller === undefined
                ? {}
                : { controller: this.#controller }),
        };
    }

    #acceptOperationIdentity(
        identity: Pick<WorkerTerminalIdentity, "generation" | "terminalId">,
    ): void {
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
        const attached = await this.#worker.attach({
            fromSeq: this.#lastSeq,
            ...(this.#localSeq === 0 && this.#worker.control !== undefined
                ? { restore: true }
                : {}),
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
        if (attached.snapshot !== undefined) {
            // Reset the decoder as well as the terminal. A snapshot is a
            // complete state seed at an explicit Host sequence boundary; anchor
            // localSeq at snapshot.seq + 1 so client sequence continuity holds
            // across Control restarts.
            this.#decoder.end();
            this.#lastSeq = attached.snapshot.seq;
            this.#localSeq = Math.max(
                this.#localSeq + 1,
                attached.snapshot.seq + 1,
            );
            this.#emitData(attached.snapshot.data, this.#localSeq);
        }
        for (const frame of attached.replay)
            this.#acceptOutput(frame.seq, frame.dataBase64);
        if (attached.exit !== undefined) {
            this.#acceptExit(
                {
                    exitCode: attached.exit.exitCode,
                    signal: attached.exit.signal,
                },
                attached.session.version,
            );
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
        if (notification.method === "terminal.error") {
            this.#scheduleResume();
            return;
        }
        if (notification.method === "terminal.output") {
            if (notification.params.seq > this.#lastSeq + 1) {
                this.#scheduleResume();
                return;
            }
            this.#acceptOutput(
                notification.params.seq,
                notification.params.dataBase64,
            );
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
        this.#emitData(decoded, ++this.#localSeq);
    }

    #acceptExit(exit: TerminalProcessExit, version: number): void {
        if (this.#closed) return;
        const finalText = this.#decoder.end();
        if (finalText.length > 0 && this.#lastSeq > 0) {
            this.#emitData(finalText, ++this.#localSeq);
        }
        this.#descriptor = { ...this.#descriptor, state: "exited", version };
        this.#exit = exit;
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
        clearInterval(this.#controlHeartbeat);
        this.#controlHeartbeat = undefined;
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
