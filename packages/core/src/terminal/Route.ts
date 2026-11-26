import {
    routeModule,
    createRemoteError,
    STREAM_GAP_CODE,
    type JsonValue,
    type ControlPortDefinition,
    type ControlStreamMessage,
    type TerminalAttachInput,
    type TerminalOpenInput,
    type TerminalOutputFrame,
    controlErrorCodes,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import type {
    TerminalAttachment,
    TerminalBackend,
    TerminalSessionApi,
} from "./Api.js";

interface TerminalRouteModuleOptions {
    backend: TerminalBackend;
    instance: string;
    maxUnackedBytes?: number;
    onRetiring?: (detach: () => void) => () => void;
    sessions: TerminalSessionApi;
}

export function createTerminalRouteModule(
    options: TerminalRouteModuleOptions,
): ControlPortDefinition {
    const maxUnackedBytes = options.maxUnackedBytes ?? 1024 * 1024;
    let recovery: Promise<void> | undefined;
    const ensureRecovered = async (): Promise<void> => {
        if (options.backend.recover === undefined) return;
        recovery ??= options.sessions
            .recover(options.instance, options.backend)
            .then(() => undefined)
            .finally(() => {
                recovery = undefined;
            });
        await recovery;
    };
    if (!Number.isSafeInteger(maxUnackedBytes) || maxUnackedBytes < 1) {
        throw new TypeError(
            "Terminal maxUnackedBytes must be a positive safe integer.",
        );
    }
    return routeModule(
        "terminal",
        {
            open: async (request) => {
                await ensureRecovered();
                const input = readOpenInput(request.payload);
                return (await options.sessions.open({
                    backend: options.backend,
                    cols: input.cols,
                    ...(input.command === undefined
                        ? {}
                        : { command: input.command }),
                    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                    instance: options.instance,
                    ...(input.name === undefined ? {} : { name: input.name }),
                    ...(input.persistent === undefined
                        ? {}
                        : { persistent: input.persistent }),
                    rows: input.rows,
                    ...(input.shell === undefined ? {} : { shell: input.shell }),
                    workspace: input.workspace,
                })) as unknown as JsonValue;
            },
            list: async () => {
                await ensureRecovered();
                return options.sessions.list(
                    options.instance,
                ) as unknown as JsonValue;
            },
            get: async (request) => {
                await ensureRecovered();
                const input = readIdentity(request.payload);
                const session = options.sessions.get(input.terminalId);
                assertInstance(session.instance, options.instance);
                assertGeneration(
                    session.generation,
                    input.generation,
                    input.terminalId,
                );
                return session as unknown as JsonValue;
            },
            inspect: async (request) => {
                await ensureRecovered();
                const input = readIdentity(request.payload);
                const session = options.sessions.get(input.terminalId);
                assertInstance(session.instance, options.instance);
                return (await options.sessions.inspect(
                    input.terminalId,
                    input.generation,
                )) as unknown as JsonValue;
            },
            kill: async (request) => {
                await ensureRecovered();
                const input = readVersionedIdentity(request.payload);
                const session = options.sessions.get(input.terminalId);
                assertInstance(session.instance, options.instance);
                return (await options.sessions.kill(
                    input.terminalId,
                    input.generation,
                    input.version,
                )) as unknown as JsonValue;
            },
        },
        {
            attach: async (stream, request, context) => {
                await ensureRecovered();
                const input = readAttachInput(request.payload);
                const current = options.sessions.get(input.terminalId);
                assertInstance(current.instance, options.instance);
                assertGeneration(
                    current.generation,
                    input.generation,
                    input.terminalId,
                );
                if (current.pty === false && input.takeover === true) {
                    throw invalidInput(
                        "Pipe tasks are read-only and do not support takeover.",
                    );
                }
                let sendTail = Promise.resolve();
                let terminal = false;
                let endedFlag = false;
                let pendingBytes = 0;
                let lastAckedSeq = input.fromSeq;
                const pendingFrames = new Map<number, number>();
                const prunePendingThrough = (seq: number) => {
                    for (const [frameSeq, bytes] of pendingFrames) {
                        if (frameSeq <= seq) {
                            pendingFrames.delete(frameSeq);
                            pendingBytes -= bytes;
                        }
                    }
                };
                const sendSerialized = (
                    message: ControlStreamMessage,
                ): Promise<void> => {
                    if (terminal || endedFlag) return Promise.resolve();
                    const queued = sendTail.then(async () => {
                        if (endedFlag) return;
                        await stream.send(message);
                    });
                    sendTail = queued.catch(() => undefined);
                    return queued;
                };
                // Registered stream callbacks can close before attach completes.
                // Keep this binding unset until a durable attachment exists.
                // eslint-disable-next-line prefer-const
                let attachment: TerminalAttachment | undefined;
                let seeded = false;
                let beforeSeedBytes = 0;
                let seedOverflow = false;
                const beforeSeed: TerminalOutputFrame[] = [];
                let beforeSeedExit:
                    { exitCode: number; signal: number } | undefined;

                const offData = stream.onData(async (message) => {
                    const event = message as ControlStreamMessage;
                    const payload = readRecord(event.payload);
                    if (event.name === "ack") {
                        const identity = readAckIdentity(payload);
                        if (identity.terminalId !== current.terminalId)
                            throw invalidInput(
                                "Terminal stream identity does not match the attachment.",
                            );
                        const acknowledged = options.sessions.get(
                            identity.terminalId,
                        );
                        assertGeneration(
                            acknowledged.generation,
                            identity.generation,
                            identity.terminalId,
                        );
                        if (
                            identity.throughSeq < lastAckedSeq ||
                            identity.throughSeq > acknowledged.latestSeq
                        )
                            throw invalidInput(
                                "Terminal acknowledgement sequence is invalid.",
                            );
                        lastAckedSeq = identity.throughSeq;
                        prunePendingThrough(identity.throughSeq);
                        return;
                    }

                    if (attachment === undefined)
                        throw invalidInput("Terminal attachment is not ready.");
                    const identity = readStreamIdentity(payload);
                    if (identity.terminalId !== current.terminalId)
                        throw invalidInput(
                            "Terminal stream identity does not match the attachment.",
                        );
                    if (event.name === "control") {
                        const target = options.sessions.get(identity.terminalId);
                        assertGeneration(
                            target.generation,
                            identity.generation,
                            identity.terminalId,
                        );
                        const takeover = payload.takeover === true;
                        try {
                            const snapshot = takeover
                                ? await attachment.takeControl()
                                : (await attachment.releaseControl(), undefined);
                            if (snapshot !== undefined) {
                                lastAckedSeq = Math.max(
                                    lastAckedSeq,
                                    snapshot.seq,
                                );
                                prunePendingThrough(lastAckedSeq);
                            }
                            await sendSerialized({
                                name: "controlChanged",
                                payload: {
                                    clientSeq: identity.clientSeq,
                                    humanControl: takeover,
                                    session: options.sessions.get(
                                        identity.terminalId,
                                    ),
                                    ...(snapshot === undefined
                                        ? {}
                                        : { snapshot }),
                                } as unknown as JsonValue,
                            });
                        } catch (error) {
                            const currentSession = options.sessions.get(
                                identity.terminalId,
                            );
                            await sendSerialized({
                                name: "controlChanged",
                                payload: {
                                    clientSeq: identity.clientSeq,
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : String(error),
                                    humanControl: takeover
                                        ? false
                                        : currentSession.humanControl === true,
                                    session: currentSession,
                                } as unknown as JsonValue,
                            });
                        }
                        return;
                    }
                    options.sessions.assertVersion(
                        identity.terminalId,
                        identity.generation,
                        identity.version,
                    );
                    if (event.name === "input") {
                        await attachment.write(
                            readStringField(event.payload, "data"),
                        );
                        await stream.send({
                            name: "inputAccepted",
                            payload: {
                                clientSeq: identity.clientSeq,
                                generation: identity.generation,
                                requestId: context.requestId,
                                terminalId: identity.terminalId,
                                version: identity.version,
                            },
                        });
                        return;
                    }
                    if (event.name === "resize") {
                        await attachment.resize(
                            readIntegerField(payload, "cols"),
                            readIntegerField(payload, "rows"),
                        );
                        const resized = options.sessions.get(
                            identity.terminalId,
                        );
                        await stream.send({
                            name: "resized",
                            payload: {
                                clientSeq: identity.clientSeq,
                                generation: identity.generation,
                                requestId: context.requestId,
                                terminalId: identity.terminalId,
                                version: resized.version,
                            },
                        });
                        return;
                    }
                    throw invalidInput(
                        `Unsupported terminal stream event: ${event.name}`,
                    );
                });

                let resolveEnded!: () => void;
                const ended = new Promise<void>((resolve) => {
                    resolveEnded = resolve;
                });
                const end = () => {
                    if (endedFlag) return;
                    endedFlag = true;
                    attachment?.detach();
                    resolveEnded();
                };
                const offClose = stream.onClose(end);
                const offCancel = stream.onCancel(end);
                const enqueueOutput = (frame: TerminalOutputFrame) => {
                    if (!seeded) {
                        beforeSeedBytes += Buffer.byteLength(
                            frame.data,
                            "utf8",
                        );
                        if (beforeSeedBytes > maxUnackedBytes)
                            seedOverflow = true;
                        if (!seedOverflow) beforeSeed.push(frame);
                        return;
                    }
                    if (terminal || frame.seq <= lastAckedSeq) return;
                    const bytes = Buffer.byteLength(frame.data, "utf8");
                    if (pendingBytes + bytes > maxUnackedBytes) {
                        terminal = true;
                        const error = createRemoteError({
                            code: STREAM_GAP_CODE,
                            details: {
                                lastAckedSeq,
                                maxUnackedBytes,
                                terminalId: current.terminalId,
                            },
                            message:
                                "Terminal attachment exceeded its unacknowledged output window.",
                            retryable: true,
                        }).toBody();
                        sendTail = sendTail.then(async () => {
                            await stream.cancel(error);
                            end();
                        });
                        return;
                    }
                    pendingBytes += bytes;
                    pendingFrames.set(frame.seq, bytes);
                    sendTail = sendTail.then(() =>
                        stream.send({
                            name: "output",
                            payload: frame as unknown as JsonValue,
                            seq: frame.seq,
                        }),
                    );
                };
                const enqueueExit = (exit: {
                    exitCode: number;
                    signal: number;
                }) => {
                    if (!seeded) {
                        beforeSeedExit = exit;
                        return;
                    }
                    if (terminal) return;
                    terminal = true;
                    const completed = options.sessions.get(input.terminalId);
                    sendTail = sendTail.then(async () => {
                        await stream.send({
                            name: "exit",
                            payload: exit as unknown as JsonValue,
                        });
                        await stream.close(completed as unknown as JsonValue);
                        end();
                    });
                };

                attachment = options.sessions.attach({
                    fromSeq: input.fromSeq,
                    takeover: input.takeover,
                    generation: input.generation,
                    onExit: enqueueExit,
                    onOutput: enqueueOutput,
                    terminalId: input.terminalId,
                });
                let resolveRetiring!: () => void;
                const retiring = new Promise<void>((resolve) => {
                    resolveRetiring = resolve;
                });
                const offRetiring = options.onRetiring?.(() => {
                    // Detach only this stream: the remote PTY and its durable
                    // session must remain alive for reconnect/replay. Releasing
                    // the wait here lets the Instance drain its stream lease.
                    end();
                    resolveRetiring();
                    void sendTail
                        .then(() => stream.close())
                        .catch(() => undefined);
                });
                try {
                    const needsObserveSnapshot =
                        current.pty !== false &&
                        !input.takeover &&
                        input.fromSeq === 0 &&
                        current.latestSeq > 0 &&
                        (attachment.replay.length === 0 ||
                            attachment.replay[0]!.seq > 1);
                    const snapshot = input.takeover
                        ? await attachment.takeControl()
                        : needsObserveSnapshot
                          ? await attachment.restoreSnapshot()
                          : undefined;
                    if (endedFlag) {
                        attachment.detach();
                        return;
                    }
                    if (seedOverflow)
                        throw createRemoteError({
                            code: STREAM_GAP_CODE,
                            message:
                                "Terminal output exceeded the attach buffer while restoring state.",
                            retryable: true,
                        });
                    if (snapshot !== undefined)
                        lastAckedSeq = Math.max(lastAckedSeq, snapshot.seq);
                    await stream.send({
                        name: "seed",
                        payload: {
                            session: options.sessions.get(input.terminalId),
                            ...(snapshot === undefined ? {} : { snapshot }),
                        } as unknown as JsonValue,
                    });
                    if (seedOverflow)
                        throw createRemoteError({
                            code: STREAM_GAP_CODE,
                            message:
                                "Terminal output exceeded the attach buffer while sending the state seed.",
                            retryable: true,
                        });
                    seeded = true;
                    for (const frame of attachment.replay) enqueueOutput(frame);
                    for (const frame of beforeSeed) enqueueOutput(frame);
                    if (beforeSeedExit !== undefined)
                        enqueueExit(beforeSeedExit);
                    if (attachment.exit !== undefined)
                        enqueueExit(attachment.exit);
                    // A client can indefinitely backpressure a send. Retiring
                    // an Instance must still detach and release the stream
                    // lease rather than waiting on that client's network IO.
                    await Promise.race([sendTail, retiring]);
                    if (!endedFlag) await ended;
                    await Promise.race([sendTail, retiring]);
                } finally {
                    offRetiring?.();
                    end();
                    offData();
                    offClose();
                    offCancel();
                }
            },
        },
    );
}

function readOpenInput(value: JsonValue | undefined): TerminalOpenInput {
    const payload = readRecord(value);
    if (
        payload.persistent !== undefined &&
        typeof payload.persistent !== "boolean"
    ) {
        throw invalidInput("Terminal persistent must be a boolean.");
    }
    return {
        cols: readIntegerField(payload, "cols"),
        ...(payload.command === undefined
            ? {}
            : { command: readString(payload.command, "command") }),
        ...(payload.cwd === undefined
            ? {}
            : { cwd: readString(payload.cwd, "cwd") }),
        ...(payload.name === undefined
            ? {}
            : { name: readString(payload.name, "name") }),
        ...(payload.persistent === undefined
            ? {}
            : { persistent: payload.persistent }),
        rows: readIntegerField(payload, "rows"),
        ...(payload.shell === undefined
            ? {}
            : { shell: readString(payload.shell, "shell") }),
        workspace: readString(payload.workspace, "workspace"),
    };
}

function readAttachInput(value: JsonValue | undefined): TerminalAttachInput {
    const payload = readRecord(value);
    return {
        fromSeq: readIntegerField(payload, "fromSeq"),
        ...(payload.takeover === true ? { takeover: true } : {}),
        generation: readIntegerField(payload, "generation"),
        terminalId: readStringField(payload, "terminalId"),
    };
}

function readIdentity(value: JsonValue | undefined): {
    generation: number;
    terminalId: string;
} {
    const payload = readRecord(value);
    return {
        generation: readIntegerField(payload, "generation"),
        terminalId: readStringField(payload, "terminalId"),
    };
}

function readVersionedIdentity(value: JsonValue | undefined): {
    generation: number;
    terminalId: string;
    version: number;
} {
    const payload = readRecord(value);
    return {
        generation: readIntegerField(payload, "generation"),
        terminalId: readStringField(payload, "terminalId"),
        version: readIntegerField(payload, "version"),
    };
}

function readAckIdentity(value: Record<string, JsonValue>): {
    generation: number;
    terminalId: string;
    throughSeq: number;
    version: number;
} {
    return {
        generation: readIntegerField(value, "generation"),
        terminalId: readString(value.terminalId, "terminalId"),
        throughSeq: readIntegerField(value, "throughSeq"),
        version: readIntegerField(value, "version"),
    };
}

function readStreamIdentity(value: Record<string, JsonValue>): {
    clientSeq: number;
    generation: number;
    terminalId: string;
    version: number;
} {
    return {
        clientSeq: readIntegerField(value, "clientSeq"),
        generation: readIntegerField(value, "generation"),
        terminalId: readString(value.terminalId, "terminalId"),
        version: readIntegerField(value, "version"),
    };
}

function readRecord(value: JsonValue | undefined): Record<string, JsonValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalidInput("Terminal input must be an object.");
    }
    return value;
}

function readStringField(value: JsonValue | undefined, field: string): string {
    return readString(readRecord(value)[field], field);
}

function readString(value: JsonValue | undefined, field: string): string {
    if (typeof value !== "string")
        throw invalidInput(`Terminal ${field} must be a string.`);
    return value;
}

function readIntegerField(
    value: Record<string, JsonValue>,
    field: string,
): number {
    const current = value[field];
    if (typeof current !== "number" || !Number.isSafeInteger(current)) {
        throw invalidInput(`Terminal ${field} must be a safe integer.`);
    }
    return current;
}

function assertInstance(actual: string, expected: string): void {
    if (actual !== expected) {
        throw createRemoteError({
            code: runtimeErrorCodes.instanceConflict,
            details: { actual, expected },
            message: "Terminal belongs to another instance.",
            retryable: false,
        });
    }
}

function assertGeneration(
    actual: number,
    expected: number,
    terminalId: string,
): void {
    if (actual !== expected) {
        throw createRemoteError({
            code: runtimeErrorCodes.instanceConflict,
            details: {
                actualGeneration: actual,
                requestedGeneration: expected,
                terminalId,
            },
            message: "Terminal generation is stale.",
            retryable: true,
        });
    }
}

function invalidInput(message: string): Error {
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message,
        retryable: false,
    });
}
