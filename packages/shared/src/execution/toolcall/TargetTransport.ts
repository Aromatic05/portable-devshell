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
    rejection?: RemoteErrorBody;
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
        dispatch: async (request) => {
            await endpoint.connect(asInstanceName(instance), "tool", request.signal);
            return await dispatchOverTransport(port, request);
        },
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
            toolCallFailureEnvelope(
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

    const callbacks = new ToolCallCallbackServer(stream);
    const executionSignal = signal === undefined ? callbacks.signal : AbortSignal.any([signal, callbacks.signal]);
    let progressTail = Promise.resolve();
    const emitProgress = (progress: JsonValue) => {
        progressTail = progressTail.then(() =>
            stream.send({ name: "progress", payload: progress }),
        );
    };
    try {
        const request: ToolCallDispatchRequest = {
            callId: opened.callId,
            ...(opened.rejection === undefined ? {} : { rejection: opened.rejection }),
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
            signal: executionSignal,
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
        await stream.close(toolCallFailureEnvelope(error));
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
            ...(request.rejection === undefined ? {} : { rejection: request.rejection }),
            value: request.value,
        } satisfies DispatchOpenPayload,
    );
    return await receiveToolCallResult(stream, request);
}

type ToolCallTransportCallbacks = Pick<ToolCallDispatchRequest,
    "invocationInput" | "transformResult" | "onProgress" | "signal"
> & Partial<Pick<ToolCallDispatchRequest, "execute" | "hooks">>;

/** The ToolCall callback wire is shared by ingress adapters and target dispatch. */
export async function receiveToolCallResult(
    stream: MessageStream,
    request: ToolCallTransportCallbacks,
): Promise<JsonValue> {
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
                    payload: {
                        id: callback.id,
                        ...wireFailure(error),
                        ...(request.signal?.aborted && (error === request.signal.reason ||
                            (error instanceof Error && error.name === "AbortError")) ? { aborted: true } : {}),
                    },
                });
            }
        });
        return callbackTail;
    });
    // Cancellation is a ToolCall message: keep the stream alive until the
    // owning Instance has drained execution and released its hook leases.
    const aborted = () => {
        void stream.send({ name: "abort", payload: {
            message: request.signal?.reason instanceof Error ? request.signal.reason.message : "ToolCall cancelled.",
        } }).catch(() => undefined);
    };
    request.signal?.addEventListener("abort", aborted, { once: true });
    if (request.signal?.aborted) aborted();
    try {
        const terminal = await waitForTerminal(stream);
        await callbackTail;
        return readTerminalResult(terminal);
    } finally {
        offData();
        request.signal?.removeEventListener("abort", aborted);
    }
}

async function invokeCallback(
    request: ToolCallTransportCallbacks,
    callback: CallbackMessage,
    onProgress: (progress: JsonValue) => void,
): Promise<JsonValue> {
    const payload = record(callback.payload);
    if (payload === undefined)
        throw new TypeError(`Invalid ToolCall ${callback.kind} callback payload.`);
    switch (callback.kind) {
        case "review":
            if (request.hooks === undefined) throw new Error("ToolCall review callback is unavailable.");
            return (await request.hooks.review(
                callback.payload as unknown as ToolCallReviewInput,
            )) as unknown as JsonValue;
        case "rewrite":
            if (request.hooks === undefined) throw new Error("ToolCall rewrite callback is unavailable.");
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
                payload.input as JsonValue,
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
                payload.input as JsonValue,
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
                payload.result as JsonValue,
                payload.callId,
                payload.presentation as ToolCallPresentation | undefined,
            );
        }
    }
}

export class ToolCallCallbackServer {
    readonly #controller = new AbortController();

    get signal(): AbortSignal { return this.#controller.signal; }
    readonly #pending = new Map<number, PendingCallback>();
    readonly #offData: () => void;
    readonly #offClose: () => void;
    readonly #offCancel: () => void;
    #nextId = 1;

    constructor(private readonly stream: MessageStream) {
        this.#offData = stream.onData((message) => this.#accept(message));
        this.#offClose = stream.onClose(() => {
            const error = new Error("ToolCall stream closed.");
            this.#controller.abort(error);
            this.#failAll(error);
        });
        this.#offCancel = stream.onCancel((error) => {
            const failure = streamFailure(error);
            this.#controller.abort(failure);
            this.#failAll(failure);
        });
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
        if (entry?.name === "abort") {
            const payload = record(entry.payload);
            this.#controller.abort(new Error(typeof payload?.message === "string" ? payload.message : "ToolCall cancelled."));
            return;
        }
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
            // Preserve the identity of throwIfAborted() across callback wire.
            // ExecutionTarget uses it to distinguish interruption from tool failure.
            pending.reject(payload.aborted === true && this.signal.aborted
                ? this.signal.reason : readWireFailure(payload));
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
        (input.rejection !== undefined && !isRemoteErrorBody(input.rejection)) ||
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
        ...(input.rejection === undefined ? {} : { rejection: input.rejection as RemoteErrorBody }),
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
        payload: input.payload as JsonValue,
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

export function toolCallFailureEnvelope(error: unknown): JsonValue {
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

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
