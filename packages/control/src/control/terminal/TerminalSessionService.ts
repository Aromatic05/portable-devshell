import { randomUUID } from "node:crypto";

import {
    createError,
    errorCodes,
    type TerminalSessionDescriptor,
    type TerminalSessionState,
    type TerminalOutputFrame,
} from "@portable-devshell/shared";

import type {
    TerminalBackend,
    TerminalBackendOpenResult,
    TerminalBackendSession,
    TerminalProcess,
    TerminalProcessExit,
} from "./TerminalProcess.js";

const DEFAULT_MAX_REPLAY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TERMINAL_HISTORY = 64;

interface TerminalSessionRecord {
    attachments: Set<TerminalAttachmentRecord>;
    cols: number;
    createdAt: string;
    exit?: TerminalProcessExit;
    generation: number;
    instance: string;
    killPending: boolean;
    latestSeq: number;
    pendingKillExit?: TerminalProcessExit;
    process: TerminalProcess;
    processDisposed: boolean;
    processSubscriptions: Array<() => void>;
    replay: Array<TerminalOutputFrame & { bytes: number }>;
    replayBytes: number;
    recoverable: boolean;
    rows: number;
    state: TerminalSessionState;
    terminalId: string;
    version: number;
}

interface TerminalAttachmentRecord {
    detached: boolean;
    onExit?(exit: TerminalProcessExit): void;
    onOutput(frame: TerminalOutputFrame): void;
}

export interface TerminalSessionServiceOptions {
    idFactory?: () => string;
    maxReplayBytes?: number;
    maxTerminalHistory?: number;
    now?: () => Date;
}

export interface TerminalOpenRequest {
    backend: TerminalBackend;
    cols: number;
    command?: string;
    cwd?: string;
    instance: string;
    rows: number;
    workspace: string;
}

export interface TerminalAttachRequest {
    fromSeq: number;
    generation: number;
    onExit?(exit: TerminalProcessExit): void;
    onOutput(frame: TerminalOutputFrame): void;
    terminalId: string;
}

export interface TerminalAttachment {
    readonly exit?: TerminalProcessExit;
    readonly replay: TerminalOutputFrame[];
    readonly session: TerminalSessionDescriptor;
    detach(): void;
    resize(cols: number, rows: number): Promise<void>;
    write(data: string): Promise<void>;
}

export class TerminalSessionService {
    readonly #idFactory: () => string;
    readonly #instanceEpochs = new Map<string, number>();
    readonly #maxReplayBytes: number;
    readonly #maxTerminalHistory: number;
    readonly #now: () => Date;
    readonly #sessions = new Map<string, TerminalSessionRecord>();
    #closed = false;
    #nextGeneration = 1;

    constructor(options: TerminalSessionServiceOptions = {}) {
        this.#idFactory = options.idFactory ?? (() => `terminal-${randomUUID()}`);
        this.#maxReplayBytes = options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES;
        if (!Number.isSafeInteger(this.#maxReplayBytes) || this.#maxReplayBytes < 1) {
            throw new TypeError("Terminal maxReplayBytes must be a positive safe integer.");
        }
        this.#maxTerminalHistory = options.maxTerminalHistory ?? DEFAULT_MAX_TERMINAL_HISTORY;
        if (!Number.isSafeInteger(this.#maxTerminalHistory) || this.#maxTerminalHistory < 0) {
            throw new TypeError("Terminal maxTerminalHistory must be a non-negative safe integer.");
        }
        this.#now = options.now ?? (() => new Date());
    }

    async open(request: TerminalOpenRequest): Promise<TerminalSessionDescriptor> {
        this.#assertOpen();
        assertDimensions(request.cols, request.rows);
        const epoch = this.#instanceEpoch(request.instance);
        const opened = await request.backend.open({
            cols: request.cols,
            ...(request.command === undefined ? {} : { command: request.command }),
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
            rows: request.rows,
            workspace: request.workspace,
        });
        if (this.#closed || this.#instanceEpoch(request.instance) !== epoch) {
            await disposeUnregistered(opened);
            throw this.#closed
                ? serviceClosedError()
                : instanceBackendReplacedError(request.instance);
        }
        return this.#registerOpened(request.instance, opened, request.cols, request.rows);
    }


    async recover(instance: string, backend: TerminalBackend): Promise<TerminalSessionDescriptor[]> {
        this.#assertOpen();
        if (backend.recover === undefined) return this.list(instance);
        const epoch = this.#instanceEpoch(instance);
        const recovered = await backend.recover();
        if (this.#closed || this.#instanceEpoch(instance) !== epoch) {
            await Promise.all(recovered.map(disposeUnregistered));
            throw this.#closed
                ? serviceClosedError()
                : instanceBackendReplacedError(instance);
        }
        for (const opened of recovered) {
            if (this.#sessions.has(opened.identity.terminalId)) {
                await disposeUnregistered(opened);
                continue;
            }
            this.#registerOpened(
                instance,
                opened,
                opened.identity.cols ?? 80,
                opened.identity.rows ?? 24
            );
        }
        return this.list(instance);
    }

    attach(request: TerminalAttachRequest): TerminalAttachment {
        const session = this.#require(request.terminalId, request.generation);
        assertSequence(request.fromSeq);
        const oldestAvailableSeq = session.replay[0]?.seq ?? session.latestSeq + 1;
        if (request.fromSeq < oldestAvailableSeq - 1) {
            throw createError({
                code: errorCodes.streamGap,
                details: {
                    latestSeq: session.latestSeq,
                    oldestAvailableSeq,
                    requestedFromSeq: request.fromSeq,
                    terminalId: session.terminalId,
                },
                message: "Requested terminal output sequence is no longer available.",
                retryable: true,
            });
        }
        const attachment: TerminalAttachmentRecord = {
            detached: false,
            ...(request.onExit === undefined ? {} : { onExit: request.onExit }),
            onOutput: request.onOutput,
        };
        session.attachments.add(attachment);
        const replay = session.replay
            .filter((frame) => frame.seq > request.fromSeq)
            .map(({ data, seq }) => ({ data, seq }));
        return {
            ...(session.exit === undefined ? {} : { exit: { ...session.exit } }),
            replay,
            session: descriptor(session),
            detach: () => {
                if (attachment.detached) return;
                attachment.detached = true;
                session.attachments.delete(attachment);
            },
            resize: async (cols, rows) => {
                this.#assertActive(session);
                assertDimensions(cols, rows);
                await session.process.resize(cols, rows);
                this.#assertActive(session);
                session.cols = cols;
                session.rows = rows;
                session.version += 1;
            },
            write: async (data) => {
                this.#assertActive(session);
                await session.process.write(data);
            },
        };
    }

    get(terminalId: string): TerminalSessionDescriptor {
        return descriptor(this.#requireById(terminalId));
    }

    assertVersion(terminalId: string, generation: number, version: number): TerminalSessionDescriptor {
        const session = this.#require(terminalId, generation);
        this.#assertVersion(session, version);
        return descriptor(session);
    }

    list(instance?: string): TerminalSessionDescriptor[] {
        return [...this.#sessions.values()]
            .filter((session) => instance === undefined || session.instance === instance)
            .sort((left, right) => {
                const leftActive = left.state === "running" ? 1 : 0;
                const rightActive = right.state === "running" ? 1 : 0;
                return rightActive - leftActive || right.createdAt.localeCompare(left.createdAt) || right.generation - left.generation;
            })
            .map(descriptor);
    }

    async kill(
        terminalId: string,
        generation: number,
        version: number
    ): Promise<TerminalSessionDescriptor> {
        const session = this.#require(terminalId, generation);
        this.#assertVersion(session, version);
        if (session.state === "running") {
            await this.#killProcess(session);
        }
        return descriptor(session);
    }

    async closeInstance(instance: string): Promise<void> {
        this.#instanceEpochs.set(instance, this.#instanceEpoch(instance) + 1);
        const sessions = [...this.#sessions.values()].filter(
            (session) => session.instance === instance,
        );
        const failures: Error[] = [];
        for (const session of sessions) {
            if (session.state === "running") {
                try {
                    await this.#killProcess(session);
                } catch (error) {
                    const failure = error instanceof Error
                        ? error
                        : new Error(String(error));
                    failures.push(failure);
                    this.#failProcess(session, failure);
                }
            } else {
                this.#unsubscribeProcess(session);
                this.#disposeProcess(session);
            }
            session.attachments.clear();
            this.#sessions.delete(session.terminalId);
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Failed to close ${failures.length} terminal session(s) for ${instance}.`,
            );
        }
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const session of this.#sessions.values()) {
            session.attachments.clear();
            this.#unsubscribeProcess(session);
            if (session.recoverable) {
                this.#disposeProcess(session);
                continue;
            }
            if (session.state === "running") {
                session.state = "killed";
                session.version += 1;
                void Promise.resolve(session.process.kill()).catch(() => undefined);
            }
            this.#disposeProcess(session);
        }
        this.#sessions.clear();
    }


    #registerOpened(
        instance: string,
        opened: TerminalBackendOpenResult,
        cols: number,
        rows: number
    ): TerminalSessionDescriptor {
        this.#assertOpen();
        const backendSession = isBackendSession(opened) ? opened : undefined;
        const process = backendSession?.process ?? opened as TerminalProcess;
        const terminalId = backendSession?.identity.terminalId ?? this.#uniqueId();
        if (this.#sessions.has(terminalId)) {
            throw createError({
                code: errorCodes.instanceConflict,
                details: { terminalId },
                message: `Terminal ${terminalId} is already registered.`,
                retryable: true,
            });
        }
        const generation = backendSession?.identity.generation ?? this.#nextGeneration++;
        this.#nextGeneration = Math.max(this.#nextGeneration, generation + 1);
        const session: TerminalSessionRecord = {
            attachments: new Set(),
            cols,
            createdAt: backendSession?.identity.createdAt ?? this.#now().toISOString(),
            generation,
            instance,
            killPending: false,
            latestSeq: 0,
            process,
            processDisposed: false,
            processSubscriptions: [],
            replay: [],
            replayBytes: 0,
            recoverable: backendSession?.identity.recoverable ?? false,
            rows,
            state: "running",
            terminalId,
            version: backendSession?.identity.version ?? 1,
        };
        this.#sessions.set(terminalId, session);
        session.processSubscriptions.push(
            process.onData((data, sourceSeq) =>
                this.#append(session, data, sourceSeq),
            ),
        );
        const unsubscribeError = process.onError?.((error) =>
            this.#failProcess(session, error),
        );
        if (unsubscribeError !== undefined) {
            session.processSubscriptions.push(unsubscribeError);
        }
        session.processSubscriptions.push(
            process.onExit((exit) => this.#finishProcess(session, exit)),
        );
        return descriptor(session);
    }

    #append(session: TerminalSessionRecord, data: string, sourceSeq?: number): void {
        if (session.state !== "running") return;
        const nextSeq = sourceSeq ?? session.latestSeq + 1;
        if (nextSeq <= session.latestSeq) return;
        if (nextSeq !== session.latestSeq + 1) {
            this.#failProcess(
                session,
                new Error(`Terminal output gap: expected ${session.latestSeq + 1}, received ${nextSeq}.`)
            );
            return;
        }
        session.latestSeq = nextSeq;
        const frame = {
            bytes: Buffer.byteLength(data, "utf8"),
            data,
            seq: nextSeq,
        };
        session.replay.push(frame);
        session.replayBytes += frame.bytes;
        while (session.replayBytes > this.#maxReplayBytes && session.replay.length > 1) {
            const removed = session.replay.shift();
            if (removed !== undefined) session.replayBytes -= removed.bytes;
        }
        for (const attachment of [...session.attachments]) {
            if (!attachment.detached) attachment.onOutput({ data, seq: frame.seq });
        }
    }


    #failProcess(session: TerminalSessionRecord, error: Error): void {
        if (session.exit !== undefined) return;
        const message = `\r\nTerminal backend failed: ${error.message}\r\n`;
        session.latestSeq += 1;
        const frame = {
            bytes: Buffer.byteLength(message, "utf8"),
            data: message,
            seq: session.latestSeq,
        };
        session.replay.push(frame);
        session.replayBytes += frame.bytes;
        while (session.replayBytes > this.#maxReplayBytes && session.replay.length > 1) {
            const removed = session.replay.shift();
            if (removed !== undefined) session.replayBytes -= removed.bytes;
        }
        for (const attachment of [...session.attachments]) {
            if (!attachment.detached) attachment.onOutput({ data: message, seq: frame.seq });
        }
        session.exit = { exitCode: -1, signal: 0 };
        session.state = "failed";
        session.version += 1;
        for (const attachment of [...session.attachments]) {
            if (!attachment.detached) attachment.onExit?.({ ...session.exit });
        }
        this.#unsubscribeProcess(session);
        this.#disposeProcess(session);
        this.#pruneTerminalHistory(session.instance);
    }

    #finishProcess(session: TerminalSessionRecord, exit: TerminalProcessExit): void {
        if (session.exit !== undefined) return;
        if (session.killPending) {
            session.pendingKillExit = { ...exit };
            return;
        }
        session.exit = { ...exit };
        if (session.state === "running") session.state = "exited";
        session.version += 1;
        for (const attachment of [...session.attachments]) {
            if (!attachment.detached) attachment.onExit?.({ ...exit });
        }
        this.#unsubscribeProcess(session);
        this.#disposeProcess(session);
        this.#pruneTerminalHistory(session.instance);
    }

    async #killProcess(session: TerminalSessionRecord): Promise<void> {
        session.killPending = true;
        try {
            await session.process.kill();
        } catch (error) {
            session.killPending = false;
            const pendingExit = session.pendingKillExit;
            session.pendingKillExit = undefined;
            if (pendingExit !== undefined) this.#finishProcess(session, pendingExit);
            throw error;
        }
        session.killPending = false;
        session.pendingKillExit = undefined;
        if (session.state === "running") this.#completeKilled(session);
    }

    #completeKilled(session: TerminalSessionRecord): void {
        if (session.exit !== undefined) return;
        const exit = { exitCode: -1, signal: 0 };
        session.exit = exit;
        session.state = "killed";
        session.version += 1;
        for (const attachment of [...session.attachments]) {
            if (!attachment.detached) attachment.onExit?.({ ...exit });
        }
        this.#unsubscribeProcess(session);
        this.#disposeProcess(session);
        this.#pruneTerminalHistory(session.instance);
    }

    #pruneTerminalHistory(instance: string): void {
        const terminal = [...this.#sessions.values()]
            .filter((session) => session.instance === instance && session.state !== "running")
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.generation - left.generation);
        for (const session of terminal.slice(this.#maxTerminalHistory)) {
            session.attachments.clear();
            this.#unsubscribeProcess(session);
            this.#disposeProcess(session);
            this.#sessions.delete(session.terminalId);
        }
    }

    #assertOpen(): void {
        if (this.#closed) throw serviceClosedError();
    }

    #instanceEpoch(instance: string): number {
        return this.#instanceEpochs.get(instance) ?? 0;
    }

    #unsubscribeProcess(session: TerminalSessionRecord): void {
        for (const unsubscribe of session.processSubscriptions.splice(0)) {
            try {
                unsubscribe();
            } catch {
                // The process adapter may already have released its listeners.
            }
        }
    }

    #disposeProcess(session: TerminalSessionRecord): void {
        if (session.processDisposed) return;
        session.processDisposed = true;
        session.process.dispose?.();
    }


    #assertVersion(session: TerminalSessionRecord, version: number): void {
        if (session.version !== version) {
            throw createError({
                code: errorCodes.instanceConflict,
                details: {
                    actualVersion: session.version,
                    requestedVersion: version,
                    terminalId: session.terminalId,
                },
                message: "Terminal version is stale.",
                retryable: true,
            });
        }
    }

    #assertActive(session: TerminalSessionRecord): void {
        if (session.state !== "running") {
            throw createError({
                code: errorCodes.instanceConflict,
                details: {
                    state: session.state,
                    terminalId: session.terminalId,
                },
                message: `Terminal ${session.terminalId} is ${session.state}.`,
                retryable: false,
            });
        }
    }

    #require(terminalId: string, generation: number): TerminalSessionRecord {
        const session = this.#requireById(terminalId);
        if (session.generation !== generation) {
            throw createError({
                code: errorCodes.instanceConflict,
                details: {
                    actualGeneration: session.generation,
                    requestedGeneration: generation,
                    terminalId,
                },
                message: "Terminal generation is stale.",
                retryable: true,
            });
        }
        return session;
    }

    #requireById(terminalId: string): TerminalSessionRecord {
        const session = this.#sessions.get(terminalId);
        if (session === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { terminalId },
                message: `Terminal ${terminalId} was not found.`,
                retryable: false,
            });
        }
        return session;
    }

    #uniqueId(): string {
        for (;;) {
            const id = this.#idFactory();
            if (id.length === 0) throw new Error("Terminal idFactory returned an empty id.");
            if (!this.#sessions.has(id)) return id;
        }
    }
}

function isBackendSession(value: TerminalBackendOpenResult): value is TerminalBackendSession {
    return typeof value === "object" &&
        value !== null &&
        "identity" in value &&
        "process" in value;
}

async function disposeUnregistered(
    opened: TerminalBackendOpenResult,
): Promise<void> {
    const backendSession = isBackendSession(opened) ? opened : undefined;
    const process = backendSession?.process ?? (opened as TerminalProcess);
    if (backendSession?.identity.recoverable !== true) {
        await Promise.resolve(process.kill()).catch(() => undefined);
    }
    process.dispose?.();
}

function serviceClosedError(): Error {
    return createError({
        code: errorCodes.instanceConflict,
        message: "Terminal session service is closed.",
        retryable: false,
    });
}

function instanceBackendReplacedError(instance: string): Error {
    return createError({
        code: errorCodes.instanceConflict,
        details: { instance },
        message: `Terminal backend for ${instance} was replaced while opening.`,
        retryable: true,
    });
}

function descriptor(session: TerminalSessionRecord): TerminalSessionDescriptor {
    return {
        cols: session.cols,
        createdAt: session.createdAt,
        generation: session.generation,
        instance: session.instance,
        latestSeq: session.latestSeq,
        rows: session.rows,
        state: session.state,
        terminalId: session.terminalId,
        version: session.version,
    };
}

function assertDimensions(cols: number, rows: number): void {
    if (
        !Number.isSafeInteger(cols) ||
        !Number.isSafeInteger(rows) ||
        cols < 2 ||
        rows < 1 ||
        cols > 4096 ||
        rows > 4096
    ) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "Terminal dimensions are invalid.",
            retryable: false,
        });
    }
}

function assertSequence(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "Terminal fromSeq must be a non-negative safe integer.",
            retryable: false,
        });
    }
}
