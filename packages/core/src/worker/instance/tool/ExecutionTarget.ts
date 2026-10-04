import {
    createRemoteError,
    errorMessage,
    runtimeErrorCodes,
    toRemoteErrorBody,
    type CommandResult,
    type InstanceName,
    type JsonValue,
    type RemoteErrorBody,
    type ToolCallContext,
    type ToolCallFailureStage,
} from "@portable-devshell/shared";

import type { WorkerToolInvoker } from "../../tool/Invoker.js";
import type {
    WorkerToolCallScheduler,
    WorkerToolSchedulerReservation,
} from "../../tool/Scheduler.js";
import type {
    ToolCallDispatchRequest,
    ToolCallTarget,
} from "../../../tool/Pipeline.js";
import { createErrorFromBody } from "../../../tool/Error.js";
import { attachToolCallErrorPayload } from "../../../tool/ErrorPayload.js";
import {
    interpretTerminalValue,
    runOutboundPipeline,
    runOutboundReview,
} from "../../../tool/hook/Outbound.js";
import type {
    ToolCallHookContext,
    ToolCallHookValue,
} from "../../../tool/hook/Review.js";
import type { ToolCallHookSequence } from "../../../tool/hook/Sequence.js";
import { getErrorCode } from "../state/Error.js";
import {
    normalizeToolSchedulerError,
    readNonRunningSchedulerStatus,
} from "./Error.js";
import type { WorkerInstanceToolAudit } from "./record/Audit.js";
import type { WorkerInstanceToolLog } from "./record/Log.js";
import {
    asBashToolResult,
    asCommandResult,
    commandResultOutput,
} from "./record/Result.js";

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
            execute,
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
                    : await invocationInput(
                          hookValue.payload,
                          callId,
                          hookValue,
                      );
            if (operation === undefined && execute === undefined)
                this.#assertReady();
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
        let finalizedTerminal:
            | { value: ToolCallHookValue; error?: Error; result?: JsonValue }
            | undefined;
        const hookProgress =
            onProgress === undefined
                ? undefined
                : (progress: JsonValue): void => {
                      progressTail = progressTail.then(async () => {
                          if (progressFailure !== undefined) return;
                          try {
                              const outerProgress = await runOutboundPipeline(
                                  hooks,
                                  {
                                      callId: callId,
                                      direction: "outbound",
                                      value: {
                                          ...hookValue,
                                          kind: "progress",
                                          payload: progress,
                                      },
                                  },
                              );
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
                if (execute !== undefined)
                    return await execute(
                        callId,
                        innerInput,
                        hookValue,
                        signal,
                        hookProgress,
                    );
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
                hookValue =
                    progressOverride ??
                    (await runOutboundPipeline(hooks, {
                        callId: callId,
                        direction: "outbound",
                        value: {
                            ...hookValue,
                            kind: "result",
                            payload: adaptedResult,
                        },
                    }));
            } catch {
                failureStage = "outboundHook";
                throw outboundHookFailure();
            }
            const interpreted = await interpretTerminalValue(
                hookValue,
                onProgress,
            );
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
                            await this.#log.append(bashResult, runningContext);
                        }
                    },
                );
            }
            return result;
        } catch (error) {
            if (toolExecutionSucceeded) throw error;

            if (finalizedTerminal?.error !== undefined) {
                const errorCode = getErrorCode(
                    finalizedTerminal.error,
                    runtimeErrorCodes.providerFailed,
                );
                if (hostRecorded)
                    await this.#audit.failed(
                        scope,
                        runningContext,
                        errorCode,
                        undefined,
                        async () => undefined,
                        { executionCompleted: true },
                    );
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

            await runOutboundReview(hooks, {
                callId,
                direction: "outbound",
                value: outerFailure.value,
            });

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
            const nonRunningStatus = readNonRunningSchedulerStatus(errorCode);

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

function outboundHookFailure(): Error {
    return createRemoteError({
        code: runtimeErrorCodes.providerFailed,
        message: "ToolCall outbound hook failed.",
        retryable: false,
    });
}
