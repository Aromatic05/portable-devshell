import { randomUUID } from "node:crypto";

import {
    createError,
    errorCodes,
    errorMessage,
    toControlErrorBody,
    type CommandResult,
    type ControlErrorBody,
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
    readonly afterReview?: (
        callId: string,
        instance: InstanceName,
    ) => Promise<void> | void;
    readonly callId: string;
    readonly hooks: ToolCallHookSequence;
    readonly invocationInput?: (
        input: JsonValue,
    ) => Promise<JsonValue> | JsonValue;
    readonly onProgress?: (progress: JsonValue) => void;
    readonly operation?: (
        callId: string,
        input: JsonValue,
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

interface ToolCallPipelineOptions {
    hooks?: ToolCallHookProvider;
    assertReady(): void;
    audit: WorkerInstanceToolAudit;
    instanceName: InstanceName;
    log: WorkerInstanceToolLog;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class ToolCallPipeline implements ToolCallTarget {
    #hooks: ToolCallHookProvider;
    #hooksBound: boolean;
    #resolveTarget?: ToolCallTargetResolver;
    readonly #assertReady: ToolCallPipelineOptions["assertReady"];
    readonly #audit: WorkerInstanceToolAudit;
    readonly #instanceName: InstanceName;
    readonly #log: WorkerInstanceToolLog;
    readonly #toolCallScheduler: WorkerToolCallScheduler;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(options: ToolCallPipelineOptions) {
        this.#hooks = options.hooks ?? emptyToolCallHooksProvider;
        this.#hooksBound = options.hooks !== undefined;
        this.#assertReady = options.assertReady;
        this.#audit = options.audit;
        this.#instanceName = options.instanceName;
        this.#log = options.log;
        this.#toolCallScheduler = options.toolCallScheduler;
        this.#toolInvoker = options.toolInvoker;
    }

    bindHooks(hooks: ToolCallHookProvider): void {
        if (this.#hooksBound)
            throw new Error("ToolCall Hooks is already bound.");
        this.#hooks = hooks;
        this.#hooksBound = true;
    }

    bindTargetResolver(resolveTarget: ToolCallTargetResolver): void {
        this.#resolveTarget = resolveTarget;
    }

    async call(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
        ) => Promise<JsonValue>,
        invocationInput?: (input: JsonValue) => Promise<JsonValue> | JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording: "caller" | "host" = "host",
        afterReview?: (
            callId: string,
            instance: InstanceName,
        ) => Promise<void> | void,
    ): Promise<JsonValue> {
        return await this.#route(
            toolName,
            input,
            context,
            signal,
            transformResult,
            invocationInput,
            onProgress,
            recording,
            afterReview,
        );
    }

    async callOperation<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string, input: JsonValue) => Promise<T>,
        signal?: AbortSignal,
        afterReview?: (
            callId: string,
            instance: InstanceName,
        ) => Promise<void> | void,
    ): Promise<T> {
        return (await this.#route(
            toolName,
            input,
            context,
            signal,
            undefined,
            undefined,
            undefined,
            "host",
            afterReview,
            operation,
        )) as T;
    }

    async #route(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal: AbortSignal | undefined,
        transformResult:
            | ((result: JsonValue, callId: string) => Promise<JsonValue>)
            | undefined,
        invocationInput:
            ((input: JsonValue) => Promise<JsonValue> | JsonValue) | undefined,
        onProgress: ((progress: JsonValue) => void) | undefined,
        recording: "caller" | "host",
        afterReview:
            | ((callId: string, instance: InstanceName) => Promise<void> | void)
            | undefined,
        operation?: (callId: string, input: JsonValue) => Promise<JsonValue>,
    ): Promise<JsonValue> {
        throwIfToolCallAborted(signal);

        const callId = randomUUID();
        const canonicalInput = snapshotJson(input);
        const canonicalContext = Object.freeze({ ...context });
        const hostRecorded = recording === "host";
        const hookSignal = signal ?? new AbortController().signal;
        const hookContext: ToolCallHookContext = Object.freeze({
            ...canonicalContext,
            instance: this.#instanceName,
        });
        let hookValue: ToolCallHookValue = {
            context: hookContext,
            kind: "call",
            payload: canonicalInput,
            toolName,
        };

        let hookLease;
        hookLease = await this.#hooks(hookContext, hookSignal, recording);
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
                        : createError({
                              code: review.error.code,
                              ...(review.error.details === undefined
                                  ? {}
                                  : { details: review.error.details }),
                              message: rejectionMessage,
                              retryable: false,
                          });
                const error = createError({
                    code: errorCodes.coreToolCallRejected,
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
                if (hostRecorded) {
                    const scope = this.#audit.createScope(
                        callId,
                        hookValue.toolName,
                        hookValue.payload,
                        executionContext(hookValue.context),
                    );
                    await this.#audit.requested(scope);
                    await this.#audit.denied(
                        scope,
                        errorCodes.coreToolCallRejected,
                    );
                }
                throw error;
            }

            hookValue = await hooks.rewrite({
                callId,
                direction: "inbound",
                value: hookValue,
            });

            const target = this.#target(hookValue.context.instance);
            return await target.dispatch({
                ...(afterReview === undefined ? {} : { afterReview }),
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

    async dispatch(request: ToolCallDispatchRequest): Promise<JsonValue> {
        const {
            afterReview,
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

        try {
            await afterReview?.(callId, hookValue.context.instance);
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
            const hookProgress =
                onProgress === undefined
                    ? undefined
                    : (progress: JsonValue): void => {
                          progressTail = progressTail.then(async () => {
                              if (progressFailure !== undefined) return;
                              try {
                                  const outerProgress = await hooks.rewrite({
                                      callId: callId,
                                      direction: "outbound",
                                      value: {
                                          ...hookValue,
                                          kind: "progress",
                                          payload: progress,
                                      },
                                  });
                                  hookValue = outerProgress;
                                  await runOutboundReview(hooks, {
                                      callId: callId,
                                      direction: "outbound",
                                      value: outerProgress,
                                  });
                                  try {
                                      onProgress(outerProgress.payload);
                                  } catch (error) {
                                      console.warn(
                                          error instanceof Error
                                              ? error
                                              : new Error(String(error)),
                                      );
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
                    const innerInput =
                        invocationInput === undefined
                            ? hookValue.payload
                            : await invocationInput(hookValue.payload);
                    if (operation !== undefined)
                        return await operation(callId, innerInput);
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
                    hookValue = await hooks.rewrite({
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
                const result = hookValue.payload;
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
                await runOutboundReview(hooks, {
                    callId: callId,
                    direction: "outbound",
                    value: hookValue,
                });
                return result;
            } catch (error) {
                if (toolExecutionSucceeded) throw error;

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
                                errorCodes.coreProviderFailed,
                            ),
                            undefined,
                            async () => undefined,
                            auditFailure(),
                        );
                    }
                    throw hookError;
                }

                const rawErrorCode = getErrorCode(
                    outerFailure.error,
                    errorCodes.coreProviderFailed,
                );
                const errorCode =
                    rawErrorCode === "tool.cancelled"
                        ? errorCodes.coreToolCallCancelled
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
                    await runOutboundReview(hooks, {
                        callId: callId,
                        direction: "outbound",
                        value: outerFailure.value,
                    });
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
                await runOutboundReview(hooks, {
                    callId: callId,
                    direction: "outbound",
                    value: outerFailure.value,
                });
                throw outerFailure.error;
        }
    }

    #target(instance: InstanceName): ToolCallTarget {
        if (this.#resolveTarget !== undefined)
            return this.#resolveTarget(instance);
        if (instance === this.#instanceName) return this;
        throw createError({
            code: errorCodes.instanceMissing,
            details: { instance },
            message: `Instance ${instance} was not found or is disabled.`,
            retryable: false,
        });
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
        toControlErrorBody(error) ??
        ({
            code: "error.unknown",
            message: errorMessage(error),
            retryable: false,
        } satisfies ControlErrorBody);
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
    const rewrittenPayload = rewritten.payload;
    const record = rewrittenPayload as Record<string, JsonValue>;
    const rewrittenBody = record.error as unknown as ControlErrorBody;
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

function createErrorFromBody(body: ControlErrorBody): Error {
    return createError({
        code: body.code,
        ...(body.cause === undefined
            ? {}
            : { cause: createErrorFromBody(body.cause) }),
        ...(body.details === undefined ? {} : { details: body.details }),
        message: body.message,
        retryable: body.retryable,
    });
}

function outboundHookFailure(): Error {
    return createError({
        code: errorCodes.coreProviderFailed,
        message: "ToolCall outbound hook failed.",
        retryable: false,
    });
}

const emptyToolCallHooks = new ToolCallHookSequence();
const emptyToolCallHooksProvider: ToolCallHookProvider = () => ({
    release() {},
    sequence: emptyToolCallHooks,
});
