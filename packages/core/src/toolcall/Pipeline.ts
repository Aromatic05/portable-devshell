import { randomUUID } from "node:crypto";

import {
    asInstanceName,
    createRemoteError,
    runtimeErrorCodes,
    errorMessage,
    toRemoteErrorBody,
    type CommandResult,
    type RemoteErrorBody,
    type InstanceName,
    type JsonValue,
    type ToolCallContext,
    type ToolCallFailureStage,
} from "@portable-devshell/shared";

import type { WorkerToolInvoker } from "../worker/tool/Invoker.js";
import type {
    WorkerToolCallScheduler,
    WorkerToolSchedulerReservation,
} from "../worker/tool/Scheduler.js";
import { getErrorCode } from "../worker/instance/state/Error.js";
import type { WorkerInstanceToolAudit } from "../worker/instance/tool/record/Audit.js";
import type { WorkerInstanceToolLog } from "../worker/instance/tool/record/Log.js";
import {
    normalizeToolSchedulerError,
    readNonRunningSchedulerStatus,
    throwIfToolCallAborted,
} from "../worker/instance/tool/Error.js";
import {
    asBashToolResult,
    asCommandResult,
    commandResultOutput,
} from "../worker/instance/tool/record/Result.js";
import {
    ToolCallHookSequence,
    type ToolCallHookProvider,
} from "./hook/Sequence.js";
import type { ToolCallHookContext, ToolCallHookValue } from "./hook/Review.js";
import { snapshotJson } from "./hook/Snapshot.js";
import { attachToolCallErrorPayload } from "./ErrorPayload.js";

export interface ToolCallDispatchRequest {
    readonly callId: string;
    readonly hooks: ToolCallHookSequence;
    readonly invocationInput?: (
        input: JsonValue,
        callId: string,
        finalValue: ToolCallHookValue,
    ) => Promise<JsonValue> | JsonValue;
    readonly onProgress?: (progress: JsonValue) => void;
    readonly operation?: (
        callId: string,
        input: JsonValue,
        value: ToolCallHookValue,
    ) => Promise<JsonValue>;
    readonly recording: "caller" | "host";
    readonly signal?: AbortSignal;
    readonly transformResult?: (
        result: JsonValue,
        callId: string,
    ) => Promise<JsonValue>;
    readonly value: ToolCallHookValue;
}

export interface ToolCallTarget {
    dispatch(request: ToolCallDispatchRequest): Promise<JsonValue>;
}

export type ToolCallTargetResolver = (
    instance: InstanceName,
) => ToolCallTarget;

export interface ToolCallPipelineOptions {
    hooks: ToolCallHookProvider;
    resolveTarget: ToolCallTargetResolver;
}

export class ToolCallPipeline {
    readonly #hooks: ToolCallHookProvider;
    readonly #resolveTarget: ToolCallTargetResolver;

    constructor(options: ToolCallPipelineOptions) {
        this.#hooks = options.hooks;
        this.#resolveTarget = options.resolveTarget;
    }

    async call(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
        ) => Promise<JsonValue>,
        invocationInput?: (input: JsonValue, callId: string, finalValue: ToolCallHookValue) => Promise<JsonValue> | JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording: "caller" | "host" = "host",
    ): Promise<JsonValue> {
        return await this.#route(
            instance,
            toolName,
            input,
            context,
            signal,
            transformResult,
            invocationInput,
            onProgress,
            recording,
        );
    }

    async callOperation<T extends JsonValue>(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string, input: JsonValue, value: ToolCallHookValue) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        return (await this.#route(
            instance,
            toolName,
            input,
            context,
            signal,
            undefined,
            undefined,
            undefined,
            "host",
            operation,
        )) as T;
    }

    async #route(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal: AbortSignal | undefined,
        transformResult:
            | ((result: JsonValue, callId: string) => Promise<JsonValue>)
            | undefined,
        invocationInput:
            ((input: JsonValue, callId: string, finalValue: ToolCallHookValue) => Promise<JsonValue> | JsonValue) | undefined,
        onProgress: ((progress: JsonValue) => void) | undefined,
        recording: "caller" | "host",
        operation?: (callId: string, input: JsonValue, value: ToolCallHookValue) => Promise<JsonValue>,
    ): Promise<JsonValue> {
        throwIfToolCallAborted(signal);

        const callId = randomUUID();
        const canonicalInput = snapshotJson(input);
        const canonicalContext = Object.freeze({ ...context });
        const hookSignal = signal ?? new AbortController().signal;
        const hookContext: ToolCallHookContext = Object.freeze({
            ...canonicalContext,
            instance: asInstanceName(instance),
        });
        let hookValue: ToolCallHookValue = {
            context: hookContext,
            kind: "call",
            payload: canonicalInput,
            toolName,
        };

        const hookLease = await this.#hooks(hookContext, hookSignal, recording);
        const hooks = hookLease.sequence;

        try {
            const review = await hooks.review({
                callId,
                direction: "inbound",
                value: hookValue,
            });

            if (review.decision === "reject") {
                const rejectionMessage =
                    review.reason ??
                    `Tool call ${hookValue.toolName} was rejected by review.`;
                const rejectionCause =
                    review.error === undefined
                        ? undefined
                        : createRemoteError({
                              code: review.error.code,
                              ...(review.error.details === undefined
                                  ? {}
                                  : { details: review.error.details }),
                              message: rejectionMessage,
                              retryable: false,
                          });
                const error = createRemoteError({
                    code: runtimeErrorCodes.toolCallRejected,
                    ...(rejectionCause === undefined
                        ? {}
                        : { cause: rejectionCause }),
                    details: {
                        ...(review.reason === undefined
                            ? {}
                            : { reason: review.reason }),
                        toolName: hookValue.toolName,
                    },
                    message: rejectionMessage,
                    retryable: false,
                });
                throw error;
            }

            hookValue = await hooks.rewrite({
                callId,
                direction: "inbound",
                value: hookValue,
            });

            if (hookValue.kind !== "call") {
                hookValue = await runOutboundPipeline(hooks, {
                    callId,
                    direction: "outbound",
                    value: hookValue,
                });
                const interpreted = await interpretTerminalValue(hookValue, onProgress);
                if (interpreted.error !== undefined) throw interpreted.error;
                return interpreted.result!;
            }

            const target = this.#resolveTarget(hookValue.context.instance);
            return await target.dispatch({
                callId,
                hooks,
                ...(invocationInput === undefined ? {} : { invocationInput }),
                ...(onProgress === undefined ? {} : { onProgress }),
                ...(operation === undefined ? {} : { operation }),
                recording,
                ...(signal === undefined ? {} : { signal }),
                ...(transformResult === undefined ? {} : { transformResult }),
                value: hookValue,
            });
        } finally {
            hookLease.release();
        }
    }

}

export interface ToolCallExecutionTargetOptions {
    assertReady(): void;
    audit: WorkerInstanceToolAudit;
    instanceName: InstanceName;
    log: WorkerInstanceToolLog;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class ToolCallExecutionTarget implements ToolCallTarget {
    readonly #assertReady: ToolCallExecutionTargetOptions["assertReady"];
    readonly #audit: WorkerInstanceToolAudit;
    readonly #instanceName: InstanceName;
    readonly #log: WorkerInstanceToolLog;
    readonly #toolCallScheduler: WorkerToolCallScheduler;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(options: ToolCallExecutionTargetOptions) {
        this.#assertReady = options.assertReady;
        this.#audit = options.audit;
        this.#instanceName = options.instanceName;
        this.#log = options.log;
        this.#toolCallScheduler = options.toolCallScheduler;
        this.#toolInvoker = options.toolInvoker;
    }

    async dispatch(request: ToolCallDispatchRequest): Promise<JsonValue> {
        const {
            callId,
            hooks,
            invocationInput,
            onProgress,
            operation,
            recording,
            signal,
            transformResult,
        } = request;
        let hookValue = request.value;
        const hostRecorded = recording === "host";
        const scope = this.#audit.createScope(
            callId,
            hookValue.toolName,
            hookValue.payload,
            executionContext(hookValue.context),
        );

        if (hostRecorded) await this.#audit.requested(scope);

        let innerInput: JsonValue;
        try {
            innerInput =
                invocationInput === undefined
                    ? hookValue.payload
                    : await invocationInput(hookValue.payload, callId, hookValue);
            if (operation === undefined) this.#assertReady();
        } catch (error) {
            if (hostRecorded) await this.#audit.failActive(scope, error);
            throw error;
        }

        let reservation: WorkerToolSchedulerReservation;
        try {
            reservation = this.#toolCallScheduler.reserve(
                {
                    callId,
                    instanceName: this.#instanceName,
                    ctxId: hookValue.context.ctxId,
                    source: hookValue.context.source,
                    toolName: hookValue.toolName,
                },
                signal,
            );
        } catch (error) {
            if (hostRecorded) await this.#audit.failActive(scope, error);
            throw normalizeToolSchedulerError(error);
        }
        if (hostRecorded) await this.#audit.queued(scope);

            const runningContext = this.#audit.runningContext(scope);
            let toolExecutionSucceeded = false;
            let executionCompleted = false;
            let failureStage: ToolCallFailureStage | undefined;
            let progressTail = Promise.resolve();
            let progressFailure: unknown;
            let progressOverride: ToolCallHookValue | undefined;
            let finalizedTerminal: { value: ToolCallHookValue; error?: Error; result?: JsonValue } | undefined;
            const hookProgress =
                onProgress === undefined
                    ? undefined
                    : (progress: JsonValue): void => {
                          progressTail = progressTail.then(async () => {
                              if (progressFailure !== undefined) return;
                              try {
                                  const outerProgress = await runOutboundPipeline(hooks, {
                                      callId: callId,
                                      direction: "outbound",
                                      value: {
                                          ...hookValue,
                                          kind: "progress",
                                          payload: progress,
                                      },
                                  });
                                  hookValue = outerProgress;
                                  if (outerProgress.kind === "progress") {
                                      try {
                                          onProgress(outerProgress.payload);
                                      } catch (error) {
                                          console.warn(
                                              error instanceof Error
                                                  ? error
                                                  : new Error(String(error)),
                                          );
                                      }
                                  } else {
                                      progressOverride = outerProgress;
                                  }
                              } catch {
                                  failureStage = "outboundHook";
                                  progressFailure = outboundHookFailure();
                              }
                          });
                      };
            const flushProgress = async (): Promise<void> => {
                await progressTail;
                if (progressFailure !== undefined) throw progressFailure;
            };

            try {
                const rawResult = await reservation.run(async () => {
                    if (hostRecorded)
                        await this.#audit.running(scope, runningContext);
                    if (operation !== undefined)
                        return await operation(callId, innerInput, hookValue);
                    return await this.#toolInvoker.invoke(
                        hookValue.toolName,
                        innerInput,
                        {
                            ...executionContext(hookValue.context),
                            operationId: callId,
                        },
                        signal,
                        hookProgress,
                    );
                });
                executionCompleted = true;
                let adaptedResult: JsonValue;
                try {
                    adaptedResult =
                        transformResult === undefined
                            ? rawResult
                            : await transformResult(rawResult, callId);
                } catch (error) {
                    failureStage = "postExecution";
                    throw error;
                }
                try {
                    await flushProgress();
                } catch (error) {
                    failureStage = "outboundHook";
                    throw error;
                }
                try {
                    hookValue = progressOverride ?? await runOutboundPipeline(hooks, {
                        callId: callId,
                        direction: "outbound",
                        value: {
                            ...hookValue,
                            kind: "result",
                            payload: adaptedResult,
                        },
                    });
                } catch {
                    failureStage = "outboundHook";
                    throw outboundHookFailure();
                }
                const interpreted = await interpretTerminalValue(hookValue, onProgress);
                finalizedTerminal = { ...interpreted, value: hookValue };
                if (interpreted.error !== undefined) throw interpreted.error;
                const result = interpreted.result!;
                toolExecutionSucceeded = true;
                if (hostRecorded) {
                    const bashResult =
                        hookValue.toolName === "bash_run"
                            ? asBashToolResult(result)
                            : undefined;
                    await this.#audit.completed(
                        scope,
                        runningContext,
                        result,
                        bashResult,
                        async () => {
                            if (bashResult !== undefined) {
                                await this.#log.append(
                                    bashResult,
                                    runningContext,
                                );
                            }
                        },
                    );
                }
                return result;
            } catch (error) {
                if (toolExecutionSucceeded) throw error;

                if (finalizedTerminal?.error !== undefined) {
                    const errorCode = getErrorCode(finalizedTerminal.error, runtimeErrorCodes.providerFailed);
                    if (hostRecorded) await this.#audit.failed(scope, runningContext, errorCode, undefined, async () => undefined, { executionCompleted: true });
                    throw finalizedTerminal.error;
                }

                await progressTail;
                const failure = progressFailure ?? error;
                const auditFailure = () =>
                    executionCompleted || failureStage !== undefined
                        ? {
                              executionCompleted,
                              ...(failureStage === undefined
                                  ? {}
                                  : { failureStage }),
                          }
                        : undefined;
                let outerFailure: ToolCallOuterError;
                try {
                    outerFailure = await rewriteToolCallError(
                        hooks,
                        callId,
                        failure,
                        hookValue,
                    );
                } catch {
                    failureStage = "outboundHook";
                    const hookError = outboundHookFailure();
                    if (hostRecorded) {
                        await this.#audit.failed(
                            scope,
                            runningContext,
                            getErrorCode(
                                hookError,
                                runtimeErrorCodes.providerFailed,
                            ),
                            undefined,
                            async () => undefined,
                            auditFailure(),
                        );
                    }
                    throw hookError;
                }

                await runOutboundReview(hooks, { callId, direction: "outbound", value: outerFailure.value });

                if (outerFailure.value.kind !== "error") {
                    const interpreted = await interpretTerminalValue(
                        outerFailure.value,
                        onProgress,
                    );
                    if (interpreted.error !== undefined) throw interpreted.error;
                    if (hostRecorded) {
                        await this.#audit.completed(
                            scope,
                            runningContext,
                            interpreted.result!,
                            undefined,
                            async () => undefined,
                        );
                    }
                    return interpreted.result!;
                }

                const rawErrorCode = getErrorCode(
                    outerFailure.error,
                    runtimeErrorCodes.providerFailed,
                );
                const errorCode =
                    rawErrorCode === "tool.cancelled"
                        ? runtimeErrorCodes.toolCallCancelled
                        : rawErrorCode;
                const nonRunningStatus =
                    readNonRunningSchedulerStatus(errorCode);

                if (nonRunningStatus !== undefined) {
                    if (hostRecorded) {
                        await this.#audit.nonRunning(
                            scope,
                            runningContext,
                            nonRunningStatus,
                            errorCode,
                        );
                    }
                    const normalized = normalizeToolSchedulerError(
                        outerFailure.error,
                    );
                    throw normalized instanceof Error
                        ? attachToolCallErrorPayload(
                              normalized,
                              outerFailure.payload,
                          )
                        : normalized;
                }

                if (hostRecorded) {
                    await this.#audit.failed(
                        scope,
                        runningContext,
                        errorCode,
                        outerFailure.result,
                        async () => {
                            if (outerFailure.result !== undefined) {
                                await this.#log.append(
                                    outerFailure.result,
                                    runningContext,
                                );
                            }
                        },
                        auditFailure(),
                    );
                }
                throw outerFailure.error;
        }
    }

}

async function runOutboundReview(
    hooks: ToolCallHookSequence,
    input: Parameters<ToolCallHookSequence["review"]>[0],
): Promise<void> {
    try {
        await hooks.review(input);
    } catch (error) {
        console.warn(error instanceof Error ? error : new Error(String(error)));
    }
}

async function runOutboundPipeline(
    hooks: ToolCallHookSequence,
    input: Parameters<ToolCallHookSequence["rewrite"]>[0],
): Promise<ToolCallHookValue> {
    const value = await hooks.rewrite(input);
    await runOutboundReview(hooks, { ...input, value });
    return value;
}

interface ToolCallOuterError {
    readonly error: Error;
    readonly payload: JsonValue;
    readonly result?: CommandResult;
    readonly value: ToolCallHookValue;
}

async function rewriteToolCallError(
    hooks: ToolCallHookSequence,
    callId: string,
    error: unknown,
    value: ToolCallHookValue,
): Promise<ToolCallOuterError> {
    const body =
        toRemoteErrorBody(error) ??
        ({
            code: "error.unknown",
            message: errorMessage(error),
            retryable: false,
        } satisfies RemoteErrorBody);
    const commandResult = asCommandResult(error);
    const payload = {
        error: body as unknown as JsonValue,
        ...(commandResult === undefined
            ? {}
            : { commandResult: commandResultOutput(commandResult) }),
    } as JsonValue;
    const rewritten = await hooks.rewrite({
        callId,
        direction: "outbound",
        value: { ...value, kind: "error", payload },
    });
    if (rewritten.kind !== "error") {
        return {
            error: new Error("rewritten terminal value"),
            payload: rewritten.payload,
            value: rewritten,
        };
    }
    const rewrittenPayload = rewritten.payload;
    const record = rewrittenPayload as Record<string, JsonValue>;
    const rewrittenBody = record.error as unknown as RemoteErrorBody;
    const rewrittenResult =
        record.commandResult === undefined
            ? undefined
            : asCommandResult(record.commandResult);
    const outerError = attachToolCallErrorPayload(
        createErrorFromBody(rewrittenBody),
        rewrittenPayload,
    );
    if (rewrittenResult !== undefined) {
        Object.assign(outerError, {
            exitCode: rewrittenResult.exitCode,
            ...(rewrittenResult.signal === undefined
                ? {}
                : { signal: rewrittenResult.signal }),
            stderr: rewrittenResult.stderr,
            stdout: rewrittenResult.stdout,
            timedOut: rewrittenResult.timedOut,
        });
    }
    return {
        error: outerError,
        payload: rewrittenPayload,
        ...(rewrittenResult === undefined ? {} : { result: rewrittenResult }),
        value: rewritten,
    };
}

function executionContext(context: ToolCallHookContext): ToolCallContext {
    const { instance: _instance, ...execution } = context;
    return execution;
}

function createErrorFromBody(body: RemoteErrorBody): Error {
    return createRemoteError({
        code: body.code,
        ...(body.cause === undefined
            ? {}
            : { cause: createErrorFromBody(body.cause) }),
        ...(body.details === undefined ? {} : { details: body.details }),
        message: body.message,
        retryable: body.retryable,
    });
}

async function interpretTerminalValue(
    value: ToolCallHookValue,
    onProgress?: (progress: JsonValue) => void,
): Promise<{ error?: Error; result?: JsonValue }> {
    if (value.kind === "error") {
        const body = (value.payload as Record<string, JsonValue>).error as unknown as RemoteErrorBody;
        return {
            error: attachToolCallErrorPayload(
                createErrorFromBody(body),
                value.payload,
            ),
        };
    }
    if (value.kind === "progress") {
        try {
            onProgress?.(value.payload);
        } catch (error) {
            console.warn(error instanceof Error ? error : new Error(String(error)));
        }
    }
    // Terminal progress/call values have no downstream consumer; expose their payload as the result.
    return { result: value.payload };
}

function outboundHookFailure(): Error {
    return createRemoteError({
        code: runtimeErrorCodes.providerFailed,
        message: "ToolCall outbound hook failed.",
        retryable: false,
    });
}
