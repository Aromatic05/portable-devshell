import { asInstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";
import {
    createRemoteError,
    isRemoteErrorBody,
    toRemoteErrorBody,
    type RemoteErrorBody,
} from "../../transport/Error.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import type {
    MessageStream,
    StreamError,
} from "../../transport/packet/Stream.js";
import type {
    ToolCallDispatchRequest,
    ToolCallReviewInput,
    ToolCallReviewResult,
    ToolCallRewriteInput,
    ToolCallTarget,
} from "./Api.js";
import {
    attachToolCallErrorPayload,
    readToolCallErrorPayload,
    type ToolCallHookValue,
    type ToolCallPresentation,
} from "./Type.js";

interface DispatchOpenPayload {
    callId: string;
    callbacks: {
        execute: boolean;
        invocationInput: boolean;
        transformResult: boolean;
    };
    recording: "caller" | "host";
    value: ToolCallHookValue;
}

type CallbackKind =
    | "execute"
    | "invocationInput"
    | "review"
    | "rewrite"
    | "transformResult";

interface CallbackMessage {
    id: number;
    kind: CallbackKind;
    payload: JsonValue;
}

interface WireFailure {
    error: RemoteErrorBody;
    toolCallPayload?: JsonValue;
}

interface PendingCallback {
    onProgress?: (progress: JsonValue) => void;
    reject(error: unknown): void;
    resolve(value: JsonValue): void;
}

export function createToolCallTargetTransport(
    endpoint: Endpoint,
    instance: string,
): ToolCallTarget {
    const port = createPortClient(endpoint, asInstanceName(instance), "tool");
    return {
        dispatch: async (request) => await dispatchOverTransport(port, request),
    };
}

export async function serveToolCallTargetDispatch(
    stream: MessageStream,
    payload: unknown,
    expectedInstance: string,
    dispatch: (request: ToolCallDispatchRequest) => Promise<JsonValue>,
    signal?: AbortSignal,
): Promise<void> {
    const opened = readDispatchOpenPayload(payload);
    if (opened.value.context.instance !== expectedInstance) {
        await stream.close(
            failureEnvelope(
                createRemoteError({
                    code: "instance.conflict",
                    details: {
                        expected: expectedInstance,
                        received: opened.value.context.instance,
                    },
                    message: `Tool call target ${opened.value.context.instance} does not match route ${expectedInstance}.`,
                    retryable: false,
                }),
            ),
        );
        return;
    }

    const callbacks = new DispatchCallbackServer(stream);
    let progressTail = Promise.resolve();
    const emitProgress = (progress: JsonValue) => {
        progressTail = progressTail.then(() =>
            stream.send({ name: "progress", payload: progress }),
        );
    };
    try {
        const request: ToolCallDispatchRequest = {
            callId: opened.callId,
            hooks: {
                review: async (input) =>
                    readReviewResult(
                        await callbacks.call(
                            "review",
                            input as unknown as JsonValue,
                        ),
                    ),
                rewrite: async (input) =>
                    readHookValue(
                        await callbacks.call(
                            "rewrite",
                            input as unknown as JsonValue,
                        ),
                    ),
            },
            onProgress: emitProgress,
            recording: opened.recording,
            ...(signal === undefined ? {} : { signal }),
            value: opened.value,
            ...(opened.callbacks.execute
                ? {
                      execute: async (
                          callId,
                          input,
                          value,
                          _signal,
                          onProgress,
                      ) =>
                          await callbacks.call(
                              "execute",
                              {
                                  callId,
                                  input,
                                  value,
                              } as unknown as JsonValue,
                              onProgress,
                          ),
                  }
                : {}),
            ...(opened.callbacks.invocationInput
                ? {
                      invocationInput: async (input, callId, finalValue) =>
                          await callbacks.call(
                              "invocationInput",
                              {
                                  callId,
                                  finalValue,
                                  input,
                              } as unknown as JsonValue,
                          ),
                  }
                : {}),
            ...(opened.callbacks.transformResult
                ? {
                      transformResult: async (
                          result,
                          callId,
                          presentation,
                      ) =>
                          await callbacks.call(
                              "transformResult",
                              {
                                  callId,
                                  ...(presentation === undefined
                                      ? {}
                                      : { presentation }),
                                  result,
                              } as unknown as JsonValue,
                          ),
                  }
                : {}),
        };
        const result = await dispatch(request);
        await progressTail;
        await stream.close({ ok: true, result });
    } catch (error) {
        await progressTail.catch(() => undefined);
        await stream.close(failureEnvelope(error));
    } finally {
        callbacks.close();
    }
}

async function dispatchOverTransport(
    port: PortClient,
    request: ToolCallDispatchRequest,
): Promise<JsonValue> {
    const stream = await port.open(
        "dispatch",
        {
            callId: request.callId,
            callbacks: {
                execute: request.execute !== undefined,
                invocationInput: request.invocationInput !== undefined,
                transformResult: request.transformResult !== undefined,
            },
            recording: request.recording,
            value: request.value,
        } satisfies DispatchOpenPayload,
        request.signal,
    );
    let callbackTail = Promise.resolve();
    const offData = stream.onData((message) => {
        const entry = record(message);
        if (entry?.name === "progress") {
            request.onProgress?.((entry.payload ?? null) as JsonValue);
            return;
        }
        if (entry?.name !== "callback") return;
        const callback = readCallbackMessage(entry.payload);
        callbackTail = callbackTail.then(async () => {
            let progressTail = Promise.resolve();
            const emitProgress = (progress: JsonValue) => {
                progressTail = progressTail.then(() =>
                    stream.send({
                        name: "callback.progress",
                        payload: { id: callback.id, progress },
                    }),
                );
            };
            try {
                const result = await invokeCallback(
                    request,
                    callback,
                    emitProgress,
                );
                await progressTail;
                await stream.send({
                    name: "callback.result",
                    payload: { id: callback.id, result },
                });
            } catch (error) {
                await progressTail.catch(() => undefined);
                await stream.send({
                    name: "callback.error",
                    payload: { id: callback.id, ...wireFailure(error) },
                });
            }
        });
        return callbackTail;
    });
    try {
        const terminal = await waitForTerminal(stream);
        await callbackTail;
        return readTerminalResult(terminal);
    } finally {
        offData();
    }
}

async function invokeCallback(
    request: ToolCallDispatchRequest,
    callback: CallbackMessage,
    onProgress: (progress: JsonValue) => void,
): Promise<JsonValue> {
    const payload = record(callback.payload);
    if (payload === undefined)
        throw new TypeError(`Invalid ToolCall ${callback.kind} callback payload.`);
    switch (callback.kind) {
        case "review":
            return (await request.hooks.review(
                callback.payload as unknown as ToolCallReviewInput,
            )) as unknown as JsonValue;
        case "rewrite":
            return (await request.hooks.rewrite(
                callback.payload as unknown as ToolCallRewriteInput,
            )) as unknown as JsonValue;
        case "invocationInput": {
            if (request.invocationInput === undefined)
                throw new Error("ToolCall invocationInput callback is unavailable.");
            if (
                typeof payload.callId !== "string" ||
                payload.input === undefined ||
                payload.finalValue === undefined
            )
                throw new TypeError("Invalid ToolCall invocationInput callback payload.");
            return await request.invocationInput(
                payload.input,
                payload.callId,
                readHookValue(payload.finalValue),
            );
        }
        case "execute": {
            if (request.execute === undefined)
                throw new Error("ToolCall execute callback is unavailable.");
            if (
                typeof payload.callId !== "string" ||
                payload.input === undefined ||
                payload.value === undefined
            )
                throw new TypeError("Invalid ToolCall execute callback payload.");
            return (await request.execute(
                payload.callId,
                payload.input,
                readHookValue(payload.value),
                request.signal,
                onProgress,
            )) as unknown as JsonValue;
        }
        case "transformResult": {
            if (request.transformResult === undefined)
                throw new Error("ToolCall transformResult callback is unavailable.");
            if (typeof payload.callId !== "string" || payload.result === undefined)
                throw new TypeError("Invalid ToolCall transformResult callback payload.");
            return await request.transformResult(
                payload.result,
                payload.callId,
                payload.presentation as ToolCallPresentation | undefined,
            );
        }
    }
}

class DispatchCallbackServer {
    readonly #pending = new Map<number, PendingCallback>();
    readonly #offData: () => void;
    readonly #offClose: () => void;
    readonly #offCancel: () => void;
    #nextId = 1;

    constructor(private readonly stream: MessageStream) {
        this.#offData = stream.onData((message) => this.#accept(message));
        this.#offClose = stream.onClose(() =>
            this.#failAll(new Error("ToolCall dispatch stream closed.")),
        );
        this.#offCancel = stream.onCancel((error) =>
            this.#failAll(streamFailure(error)),
        );
    }

    async call(
        kind: CallbackKind,
        payload: JsonValue,
        onProgress?: (progress: JsonValue) => void,
    ): Promise<JsonValue> {
        const id = this.#nextId++;
        const result = new Promise<JsonValue>((resolve, reject) => {
            this.#pending.set(id, { onProgress, reject, resolve });
        });
        try {
            await this.stream.send({
                name: "callback",
                payload: { id, kind, payload },
            });
        } catch (error) {
            this.#pending.delete(id);
            throw error;
        }
        return await result;
    }

    close(): void {
        this.#offData();
        this.#offClose();
        this.#offCancel();
        this.#failAll(new Error("ToolCall dispatch callback bridge closed."));
    }

    #accept(message: unknown): void {
        const entry = record(message);
        if (
            entry === undefined ||
            (entry.name !== "callback.result" &&
                entry.name !== "callback.error" &&
                entry.name !== "callback.progress")
        )
            return;
        const payload = record(entry.payload);
        if (payload === undefined || typeof payload.id !== "number") return;
        const pending = this.#pending.get(payload.id);
        if (pending === undefined) return;
        if (entry.name === "callback.progress") {
            pending.onProgress?.((payload.progress ?? null) as JsonValue);
            return;
        }
        this.#pending.delete(payload.id);
        if (entry.name === "callback.error") {
            pending.reject(readWireFailure(payload));
            return;
        }
        pending.resolve((payload.result ?? null) as JsonValue);
    }

    #failAll(error: unknown): void {
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
    }
}

function readDispatchOpenPayload(value: unknown): DispatchOpenPayload {
    const input = record(value);
    const callbacks = record(input?.callbacks);
    if (
        input === undefined ||
        typeof input.callId !== "string" ||
        (input.recording !== "caller" && input.recording !== "host") ||
        callbacks === undefined ||
        typeof callbacks.execute !== "boolean" ||
        typeof callbacks.invocationInput !== "boolean" ||
        typeof callbacks.transformResult !== "boolean" ||
        input.value === undefined
    )
        throw new TypeError("Invalid ToolCall dispatch request.");
    return {
        callId: input.callId,
        callbacks: {
            execute: callbacks.execute,
            invocationInput: callbacks.invocationInput,
            transformResult: callbacks.transformResult,
        },
        recording: input.recording,
        value: readHookValue(input.value),
    };
}

function readCallbackMessage(value: unknown): CallbackMessage {
    const input = record(value);
    if (
        input === undefined ||
        typeof input.id !== "number" ||
        !Number.isSafeInteger(input.id) ||
        input.id <= 0 ||
        (input.kind !== "execute" &&
            input.kind !== "invocationInput" &&
            input.kind !== "review" &&
            input.kind !== "rewrite" &&
            input.kind !== "transformResult") ||
        input.payload === undefined
    )
        throw new TypeError("Invalid ToolCall dispatch callback.");
    return {
        id: input.id,
        kind: input.kind,
        payload: input.payload,
    };
}

function readHookValue(value: unknown): ToolCallHookValue {
    const input = record(value);
    const context = record(input?.context);
    if (
        input === undefined ||
        context === undefined ||
        typeof context.instance !== "string" ||
        typeof context.source !== "string" ||
        (input.kind !== "call" &&
            input.kind !== "error" &&
            input.kind !== "progress" &&
            input.kind !== "result") ||
        input.payload === undefined ||
        typeof input.toolName !== "string"
    )
        throw new TypeError("Invalid ToolCall hook value.");
    return input as unknown as ToolCallHookValue;
}

function readReviewResult(value: unknown): ToolCallReviewResult {
    const input = record(value);
    if (
        input === undefined ||
        (input.decision !== "continue" && input.decision !== "reject")
    )
        throw new TypeError("Invalid ToolCall review result.");
    return input as unknown as ToolCallReviewResult;
}

function waitForTerminal(stream: MessageStream): Promise<unknown> {
    return new Promise((resolve, reject) => {
        stream.onClose(resolve);
        stream.onCancel((error) => reject(streamFailure(error)));
    });
}

function readTerminalResult(value: unknown): JsonValue {
    const input = record(value);
    if (input?.ok === true) return (input.result ?? null) as JsonValue;
    if (input?.ok === false) throw readWireFailure(input);
    throw new TypeError("Invalid ToolCall dispatch terminal response.");
}

function failureEnvelope(error: unknown): JsonValue {
    return { ok: false, ...wireFailure(error) } as unknown as JsonValue;
}

function wireFailure(error: unknown): WireFailure {
    const body =
        toRemoteErrorBody(error) ??
        ({
            code: "error.unknown",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
        } satisfies RemoteErrorBody);
    const toolCallPayload = readToolCallErrorPayload(error);
    return {
        error: body,
        ...(toolCallPayload === undefined ? {} : { toolCallPayload }),
    };
}

function readWireFailure(value: unknown): Error {
    const input = record(value);
    if (input === undefined || !isRemoteErrorBody(input.error))
        return new Error("Remote ToolCall callback failed.");
    let error = errorFromBody(input.error);
    if (input.toolCallPayload !== undefined)
        error = attachToolCallErrorPayload(
            error,
            input.toolCallPayload as JsonValue,
        );
    return error;
}

function errorFromBody(body: RemoteErrorBody): Error {
    return createRemoteError({
        code: body.code,
        ...(body.cause === undefined ? {} : { cause: errorFromBody(body.cause) }),
        ...(body.details === undefined ? {} : { details: body.details }),
        message: body.message,
        retryable: body.retryable,
    });
}

function streamFailure(error: StreamError | undefined): Error {
    if (error === undefined) return new Error("ToolCall dispatch stream cancelled.");
    return createRemoteError({
        code: error.code ?? "transport.cancelled",
        ...(error.details === undefined
            ? {}
            : { details: error.details as JsonValue }),
        message: error.message,
        retryable: error.retryable === true,
    });
}

function record(value: unknown): Record<string, any> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, any>)
        : undefined;
}
