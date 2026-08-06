import {
    createError,
    errorCodes,
    type JsonValue,
    type PrefixRouteModuleDefinition,
    type TerminalAttachInput,
    type TerminalOpenInput,
    type TerminalOutputFrame,
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import type { TerminalBackend } from "./TerminalProcess.js";
import type {
    TerminalAttachment,
    TerminalSessionService,
} from "./TerminalSessionService.js";

export interface TerminalRouteModuleOptions {
    backend: TerminalBackend;
    instance: string;
    maxUnackedBytes?: number;
    sessions: TerminalSessionService;
}

export function createTerminalRouteModule(
    options: TerminalRouteModuleOptions,
): PrefixRouteModuleDefinition {
    const maxUnackedBytes = options.maxUnackedBytes ?? 1024 * 1024;
    let recovered = false;
    let recovery: Promise<void> | undefined;
    const ensureRecovered = async (): Promise<void> => {
        if (recovered || options.backend.recover === undefined) {
            recovered = true;
            return;
        }
        recovery ??= options.sessions
            .recover(options.instance, options.backend)
            .then(() => {
                recovered = true;
            })
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
    return routeModule("terminal", {
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
                rows: input.rows,
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
        attach: async (request, context) => {
            await ensureRecovered();
            const input = readAttachInput(request.payload);
            const current = options.sessions.get(input.terminalId);
            assertInstance(current.instance, options.instance);
            assertGeneration(
                current.generation,
                input.generation,
                input.terminalId,
            );
            const attachmentRef: { current?: TerminalAttachment } = {};
            const streamRef: {
                current?: Awaited<ReturnType<typeof context.openStream>>;
            } = {};
            let sendTail = Promise.resolve();
            let terminal = false;
            let pendingBytes = 0;
            let lastAckedSeq = input.fromSeq;
            const pendingFrames = new Map<number, number>();
            const stream = await context.openStream(
                { session: current } as unknown as JsonValue,
                {
                    onClose: () => attachmentRef.current?.detach(),
                    onEvent: async (event) => {
                        const attachment = attachmentRef.current;
                        const activeStream = streamRef.current;
                        if (
                            attachment === undefined ||
                            activeStream === undefined
                        ) {
                            throw invalidInput(
                                "Terminal attachment is not ready.",
                            );
                        }
                        const payload = readRecord(event.payload);
                        if (event.name === "ack") {
                            const identity = readAckIdentity(payload);
                            if (identity.terminalId !== current.terminalId) {
                                throw invalidInput(
                                    "Terminal stream identity does not match the attachment.",
                                );
                            }
                            const acknowledgedSession = options.sessions.get(
                                identity.terminalId,
                            );
                            assertGeneration(
                                acknowledgedSession.generation,
                                identity.generation,
                                identity.terminalId,
                            );
                            const latest = acknowledgedSession.latestSeq;
                            if (
                                identity.throughSeq < lastAckedSeq ||
                                identity.throughSeq > latest
                            ) {
                                throw invalidInput(
                                    "Terminal acknowledgement sequence is invalid.",
                                );
                            }
                            lastAckedSeq = identity.throughSeq;
                            for (const [seq, bytes] of pendingFrames) {
                                if (seq <= identity.throughSeq) {
                                    pendingFrames.delete(seq);
                                    pendingBytes = Math.max(
                                        0,
                                        pendingBytes - bytes,
                                    );
                                }
                            }
                            return;
                        }
                        const identity = readStreamIdentity(payload);
                        if (identity.terminalId !== current.terminalId) {
                            throw invalidInput(
                                "Terminal stream identity does not match the attachment.",
                            );
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
                            await activeStream.emit("inputAccepted", {
                                clientSeq: identity.clientSeq,
                                generation: identity.generation,
                                requestId: event.id,
                                terminalId: identity.terminalId,
                                version: identity.version,
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
                            await activeStream.emit("resized", {
                                clientSeq: identity.clientSeq,
                                generation: identity.generation,
                                requestId: event.id,
                                terminalId: identity.terminalId,
                                version: resized.version,
                            });
                            return;
                        }
                        throw invalidInput(
                            `Unsupported terminal stream event: ${event.name}`,
                        );
                    },
                },
            );
            streamRef.current = stream;
            const enqueueOutput = (frame: TerminalOutputFrame) => {
                if (terminal || frame.seq <= lastAckedSeq) return;
                const bytes = Buffer.byteLength(frame.data, "utf8");
                if (pendingBytes + bytes > maxUnackedBytes) {
                    terminal = true;
                    attachmentRef.current?.detach();
                    const error = createError({
                        code: errorCodes.streamGap,
                        details: {
                            lastAckedSeq,
                            maxUnackedBytes,
                            terminalId: current.terminalId,
                        },
                        message:
                            "Terminal attachment exceeded its unacknowledged output window.",
                        retryable: true,
                    }).toBody();
                    void sendTail.finally(async () => {
                        await stream.cancel(error).catch(() => undefined);
                    });
                    return;
                }
                pendingBytes += bytes;
                pendingFrames.set(frame.seq, bytes);
                sendTail = sendTail.then(async () => {
                    await stream.emit(
                        "output",
                        frame as unknown as JsonValue,
                        frame.seq,
                    );
                });
                void sendTail.catch(async (error) => {
                    terminal = true;
                    attachmentRef.current?.detach();
                    await stream
                        .cancel(toStreamError(error))
                        .catch(() => undefined);
                });
            };
            const enqueueExit = (exit: {
                exitCode: number;
                signal: number;
            }) => {
                if (terminal) return;
                terminal = true;
                const completed = options.sessions.get(input.terminalId);
                sendTail = sendTail.then(async () => {
                    await stream.emit("exit", exit as unknown as JsonValue);
                    await stream.complete(completed as unknown as JsonValue);
                    attachmentRef.current?.detach();
                });
                void sendTail.catch(() => attachment?.detach());
            };
            const attachment = options.sessions.attach({
                fromSeq: input.fromSeq,
                generation: input.generation,
                onExit: enqueueExit,
                onOutput: enqueueOutput,
                terminalId: input.terminalId,
            });
            attachmentRef.current = attachment;
            for (const frame of attachment.replay) enqueueOutput(frame);
            if (attachment.exit !== undefined) enqueueExit(attachment.exit);
            return undefined;
        },
    });
}

function readOpenInput(value: JsonValue | undefined): TerminalOpenInput {
    const payload = readRecord(value);
    return {
        cols: readIntegerField(payload, "cols"),
        ...(payload.command === undefined
            ? {}
            : { command: readString(payload.command, "command") }),
        ...(payload.cwd === undefined
            ? {}
            : { cwd: readString(payload.cwd, "cwd") }),
        rows: readIntegerField(payload, "rows"),
    };
}

function readAttachInput(value: JsonValue | undefined): TerminalAttachInput {
    const payload = readRecord(value);
    return {
        fromSeq: readIntegerField(payload, "fromSeq"),
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
        throw createError({
            code: errorCodes.instanceConflict,
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
        throw createError({
            code: errorCodes.instanceConflict,
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
    return createError({
        code: errorCodes.targetInvalid,
        message,
        retryable: false,
    });
}

function toStreamError(error: unknown) {
    return createError({
        code: errorCodes.streamGap,
        cause: error,
        message: "Terminal stream could not keep up with output.",
        retryable: true,
    }).toBody();
}
