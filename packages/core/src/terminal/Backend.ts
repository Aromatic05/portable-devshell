import { StringDecoder } from "node:string_decoder";
import {
    STREAM_GAP_CODE,
    TRANSPORT_RPC_RESULT_UNCERTAIN_CODE,
    type TerminalInspectResult,
} from "@portable-devshell/shared";
import type {
    WorkerTerminalPort,
    WorkerTerminalDescriptor,
    WorkerTerminalIdentity,
    WorkerTerminalNotification,
    TerminalBackend,
    TerminalBackendOpenInput,
    TerminalBackendOpenResult,
    TerminalBackendSession,
    TerminalBackendSessionIdentity,
    TerminalProcess,
    TerminalProcessExit,
    TerminalProcessMetadataUpdate,
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
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.persistent === undefined
                ? {}
                : { persistent: input.persistent }),
            rows: input.rows,
            ...(input.shell === undefined ? {} : { shell: input.shell }),
            workspace: input.workspace,
        });
        const process = new WorkerTerminalProcess(
            this.options.worker,
            descriptor,
        );
        try {
            await process.initialize();
        } catch (error) {
            process.dispose();
            await process.kill().catch(() => undefined);
            throw error;
        }
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
        const sessions = descriptors.map((descriptor) => ({
            identity: remoteIdentity(descriptor),
            process: new WorkerTerminalProcess(this.options.worker, descriptor),
        }));
        try {
            await Promise.all(sessions.map(({ process }) => process.initialize()));
            return sessions;
        } catch (error) {
            for (const { process } of sessions) process.dispose();
            throw error;
        }
    }

    async listMetadata(): Promise<readonly TerminalBackendSessionIdentity[]> {
        return (await this.options.worker.list()).map(remoteIdentity);
    }
}

class WorkerTerminalProcess implements TerminalProcess {
    readonly #dataListeners = new Set<
        (data: string, sourceSeq?: number) => void
    >();
    readonly #errorListeners = new Set<(error: Error) => void>();
    readonly #controlLostListeners = new Set<() => void>();
    readonly #exitListeners = new Set<(exit: TerminalProcessExit) => void>();
    readonly #metadataListeners = new Set<
        (update: TerminalProcessMetadataUpdate) => void
    >();
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
            // A remote control lease is tied to this transport. The worker releases
            // it when the control stream closes, so never retain the old token.
            this.#clearController();
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
            this.#descriptor = { ...result.session, humanControl: true };
            this.#emitMetadata(metadataFromDescriptor(this.#descriptor));
            try {
                if (result.snapshot.seq > this.#lastSeq) await this.#resume();
                if (this.#controller !== result.controller)
                    throw new Error("Terminal control lease was lost during takeover.");
                const seq = this.#mapHostSeq(result.snapshot.seq);
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

    async restoreSnapshot(): Promise<TerminalRestore | undefined> {
        let snapshot: TerminalRestore | undefined;
        await this.#serialize(async () => {
            if (this.#closed) return;
            const attached = await this.#worker.attach({
                fromSeq: this.#lastSeq,
                generation: this.#descriptor.generation,
                restore: true,
                terminalId: this.#descriptor.terminalId,
            });
            if (this.#closed) return;
            this.#descriptor = attached.session;
            this.#emitMetadata(metadataFromDescriptor(this.#descriptor));
            if (attached.snapshot !== undefined) {
                if (attached.snapshot.seq > this.#lastSeq) {
                    await this.#applyAttached(attached);
                }
                snapshot = {
                    data: attached.snapshot.data,
                    seq: this.#mapHostSeq(attached.snapshot.seq),
                };
            }
        });
        return snapshot;
    }

    async inspect(): Promise<Omit<TerminalInspectResult, "session">> {
        if (this.#worker.inspect === undefined) {
            throw new Error("Worker does not provide terminal inspect.");
        }
        const result = await this.#worker.inspect({
            generation: this.#descriptor.generation,
            terminalId: this.#descriptor.terminalId,
        });
        this.#descriptor = result.session;
        this.#emitMetadata(metadataFromDescriptor(this.#descriptor));
        return {
            cols: result.cols,
            cursor: result.cursor,
            lines: result.lines,
            rows: result.rows,
            seq: result.seq,
        };
    }

    #mapHostSeq(hostSeq: number): number {
        if (hostSeq > this.#lastSeq) return this.#localSeq;
        const delta = this.#lastSeq - hostSeq;
        return this.#localSeq >= delta ? this.#localSeq - delta : this.#localSeq;
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
                    if (this.#controller === controller && isControlLeaseLost(error))
                        this.#clearController();
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
        let result: Awaited<ReturnType<NonNullable<WorkerTerminalPort["control"]>>>;
        try {
            result = await this.#worker.control({
                terminalId: this.#descriptor.terminalId,
                generation: this.#descriptor.generation,
                controller,
            });
        } catch (error) {
            if (this.#controller === controller && isControlLeaseLost(error))
                this.#clearController();
            throw error;
        }
        if (this.#controller === controller) {
            this.#controller = undefined;
            if (result?.session !== undefined) {
                this.#descriptor = { ...result.session, humanControl: false };
                this.#emitMetadata(metadataFromDescriptor(this.#descriptor));
            } else {
                this.#descriptor = { ...this.#descriptor, humanControl: false };
                this.#emitMetadata({ humanControl: false });
            }
        }
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

    onControlLost(listener: () => void): () => void {
        this.#controlLostListeners.add(listener);
        return () => this.#controlLostListeners.delete(listener);
    }

    onExit(listener: (exit: TerminalProcessExit) => void): () => void {
        this.#exitListeners.add(listener);
        if (this.#exit !== undefined) {
            const exit = this.#exit;
            queueMicrotask(() => listener(exit));
        }
        return () => this.#exitListeners.delete(listener);
    }

    onMetadataChange(
        listener: (update: TerminalProcessMetadataUpdate) => void,
    ): () => void {
        this.#metadataListeners.add(listener);
        return () => this.#metadataListeners.delete(listener);
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
                await this.#resume(true);
            });
        });
        this.#resumeTail = current.catch((error: unknown) => {
            this.#fail(asError(error));
        });
    }

    async #resume(background = false): Promise<void> {
        if (this.#closed) return;
        let attached;
        try {
            attached = await this.#attachForResume();
        } catch (error) {
            // A failed subscription is not evidence that the PTY died. Leave
            // the next attempt to another connection or notification.
            if (background && isTemporaryAttachError(error)) return;
            throw error;
        }
        await this.#applyAttached(attached);
    }

    async #attachForResume(): ReturnType<WorkerTerminalPort["attach"]> {
        const initialRestore =
            this.#localSeq === 0 && this.#worker.control !== undefined;
        const input = {
            fromSeq: this.#lastSeq,
            generation: this.#descriptor.generation,
            terminalId: this.#descriptor.terminalId,
        };
        try {
            return await this.#worker.attach({
                ...input,
                ...(initialRestore ? { restore: true } : {}),
            });
        } catch (error) {
            if (initialRestore || !isStreamGapError(error)) throw error;
            return await this.#worker.attach({
                ...input,
                fromSeq: this.#lastSeq,
                restore: true,
            });
        }
    }

    async #applyAttached(
        attached: Awaited<ReturnType<WorkerTerminalPort["attach"]>>,
    ): Promise<void> {
        if (this.#closed) return;
        if (
            attached.session.terminalId !== this.#descriptor.terminalId ||
            attached.session.generation !== this.#descriptor.generation
        ) {
            throw new Error("Remote terminal attachment identity changed.");
        }
        this.#descriptor = attached.session;
        this.#emitMetadata(metadataFromDescriptor(this.#descriptor));
        if (attached.snapshot !== undefined) {
            // Reset the decoder as well as the terminal. For initial recovery
            // after a Control restart (localSeq === 0), anchor localSeq at
            // snapshot.seq + 1 so client sequence continuity holds. For a
            // mid-session resync after stream.gap (localSeq > 0), advance
            // localSeq contiguously by 1 so downstream attachments receive the
            // full screen reset frame without tripping a fatal sequence gap.
            this.#decoder.end();
            this.#lastSeq = attached.snapshot.seq;
            this.#localSeq =
                this.#localSeq === 0
                    ? attached.snapshot.seq + 1
                    : this.#localSeq + 1;
            this.#emitData(attached.snapshot.data, this.#localSeq);
        } else if (
            this.#descriptor.pty === false &&
            attached.replay.length > 0 &&
            attached.replay[0]!.seq > this.#lastSeq + 1
        ) {
            this.#decoder.end();
            this.#lastSeq = attached.replay[0]!.seq - 1;
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
        if (notification.method === "terminal.control") {
            if (!notification.params.humanControl) this.#clearController();
            const update: TerminalProcessMetadataUpdate = {
                ...(notification.params.cols === undefined
                    ? {}
                    : { cols: notification.params.cols }),
                ...(notification.params.cwd === undefined
                    ? {}
                    : { cwd: notification.params.cwd }),
                humanControl: notification.params.humanControl,
                ...(notification.params.name === undefined
                    ? {}
                    : { name: notification.params.name }),
                ...(notification.params.rows === undefined
                    ? {}
                    : { rows: notification.params.rows }),
                ...(notification.params.version === undefined
                    ? {}
                    : { version: notification.params.version }),
                ...(notification.params.workspace === undefined
                    ? {}
                    : { workspace: notification.params.workspace }),
            };
            this.#descriptor = {
                ...this.#descriptor,
                ...update,
                version: Math.max(
                    this.#descriptor.version,
                    update.version ?? this.#descriptor.version,
                ),
            };
            this.#emitMetadata(update);
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
        if (notification.params.latestSeq > this.#lastSeq) {
            this.#scheduleResume();
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

    #emitMetadata(update: TerminalProcessMetadataUpdate): void {
        for (const listener of [...this.#metadataListeners]) listener(update);
    }

    #fail(error: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#disposeSubscriptions();
        for (const listener of [...this.#errorListeners]) listener(error);
    }

    #clearController(): void {
        const hadController = this.#controller !== undefined;
        this.#controller = undefined;
        clearInterval(this.#controlHeartbeat);
        this.#controlHeartbeat = undefined;
        if (!hadController) return;
        this.#descriptor = { ...this.#descriptor, humanControl: false };
        this.#emitMetadata({ humanControl: false });
        for (const listener of [...this.#controlLostListeners]) listener();
    }

    #disposeSubscriptions(): void {
        clearInterval(this.#controlHeartbeat);
        this.#controlHeartbeat = undefined;
        this.#unsubscribeConnected();
        this.#unsubscribeDisconnected();
        this.#unsubscribeNotification();
    }
}

function remoteIdentity(
    descriptor: WorkerTerminalDescriptor,
): TerminalBackendSessionIdentity {
    return {
        cols: descriptor.cols,
        ...(descriptor.command === undefined
            ? {}
            : { command: descriptor.command }),
        createdAt: new Date(descriptor.createdAtMs).toISOString(),
        ...(descriptor.cwd === undefined ? {} : { cwd: descriptor.cwd }),
        ...(descriptor.humanControl === undefined
            ? {}
            : { humanControl: descriptor.humanControl }),
        ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
        ...(descriptor.persistent === undefined
            ? {}
            : { persistent: descriptor.persistent }),
        ...(descriptor.pty === undefined ? {} : { pty: descriptor.pty }),
        recoverable: true,
        rows: descriptor.rows,
        generation: descriptor.generation,
        terminalId: descriptor.terminalId,
        version: descriptor.version,
        ...(descriptor.workspace === undefined
            ? {}
            : { workspace: descriptor.workspace }),
    };
}

function metadataFromDescriptor(
    descriptor: WorkerTerminalDescriptor,
): TerminalProcessMetadataUpdate {
    return {
        cols: descriptor.cols,
        ...(descriptor.command === undefined
            ? {}
            : { command: descriptor.command }),
        ...(descriptor.cwd === undefined ? {} : { cwd: descriptor.cwd }),
        ...(descriptor.humanControl === undefined
            ? {}
            : { humanControl: descriptor.humanControl }),
        ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
        ...(descriptor.persistent === undefined
            ? {}
            : { persistent: descriptor.persistent }),
        ...(descriptor.pty === undefined ? {} : { pty: descriptor.pty }),
        rows: descriptor.rows,
        version: descriptor.version,
        ...(descriptor.workspace === undefined
            ? {}
            : { workspace: descriptor.workspace }),
    };
}

function isControlLeaseLost(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "process.controlOwned"
    );
}

function isStreamGapError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === STREAM_GAP_CODE
    );
}

function isTemporaryAttachError(error: unknown): boolean {
    const { code, retryable } = (error ?? {}) as {
        code?: unknown;
        retryable?: unknown;
    };
    return (
        // The worker's RPC errors carry retryable; local transport errors may not.
        retryable !== false ||
        code === TRANSPORT_RPC_RESULT_UNCERTAIN_CODE ||
        code === "process.hostFailed" ||
        code === "terminal.bridgeFailed"
    );
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
