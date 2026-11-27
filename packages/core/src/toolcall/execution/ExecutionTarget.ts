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
    type ToolCallPresentation,
} from "@portable-devshell/shared";

import type { WorkerToolInvoker } from "../worker/Invoker.js";
import type { ToolCallPresentedResult } from "../Api.js";
import {
    isUrgentTool,
    type WorkerToolCallScheduler,
    type WorkerToolSchedulerCallClass,
    type WorkerToolSchedulerReservation,
} from "./Scheduler.js";
import type {
    ToolCallDispatchRequest,
    ToolCallHookContext,
    ToolCallHookValue,
    ToolCallTarget,
} from "@portable-devshell/shared";
import { createErrorFromBody } from "./Error.js";
import { assertMcpOutboundResult, mcpOutboundResult } from "./Presentation.js";
import { attachToolCallErrorPayload, readToolCallErrorPayload } from "./ErrorPayload.js";
import {
    interpretTerminalValue,
    runOutboundPipeline,
    runOutboundReview,
} from "./hook/Outbound.js";
import type { ToolCallHookSequenceApi } from "../Api.js";
import { getErrorCode } from "./Error.js";
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
    onExecutionActivity?: (ctxId: string, kind: "execution" | "mutation") => Promise<void>;
    log: WorkerInstanceToolLog;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: Pick<WorkerToolInvoker, "invoke">;
}

export class ToolCallExecutionTarget implements ToolCallTarget {
    readonly #assertReady: ToolCallExecutionTargetOptions["assertReady"];
    readonly #audit: WorkerInstanceToolAudit;
    readonly #instanceName: InstanceName;
    readonly #onExecutionActivity?: (ctxId: string, kind: "execution" | "mutation") => Promise<void>;
    readonly #log: WorkerInstanceToolLog;
    readonly #toolCallScheduler: WorkerToolCallScheduler;
    readonly #toolInvoker: Pick<WorkerToolInvoker, "invoke">;

    constructor(options: ToolCallExecutionTargetOptions) {
        this.#assertReady = options.assertReady;
        this.#audit = options.audit;
        this.#instanceName = options.instanceName;
        this.#onExecutionActivity = options.onExecutionActivity;
        this.#log = options.log;
        this.#toolCallScheduler = options.toolCallScheduler;
        this.#toolInvoker = options.toolInvoker;
    }

    async dispatch(request: ToolCallDispatchRequest): Promise<JsonValue> {
        const execution: { task?: TaskCreationEvidence } = {};
        try {
            let result: JsonValue;
            try {
                result = await this.#dispatch(request, execution);
            } finally {
                await request.finalize?.();
            }
            assertTaskDelivery(execution.task, result, request.callId);
            if (request.signal?.aborted && execution.task?.worker && execution.task.completed)
                throw createRemoteError({
                    code: runtimeErrorCodes.toolCallCancelled,
                    message: "Task creation was cancelled before its result was returned.",
                    retryable: false,
                });
            return result;
        } catch (error) {
            const task = execution.task;
            if (task === undefined) throw error;
            // The Worker may have completed its last cancellation check before
            // the cancel packet arrived. Its raw reply is still authoritative.
            // Until Core returns the result, Core owns late cancellation cleanup.
            if (request.signal?.aborted && task.worker && task.start === "confirmed" && task.running) {
                try {
                    await this.#toolInvoker.invoke("task_manage", { command: "close", task: task.id },
                        executionContext(request.value.context));
                } catch (cleanup) {
                    error = createRemoteError({
                        code: runtimeErrorCodes.toolCallCancelled,
                        message: "Task creation was cancelled; termination could not be confirmed.",
                        cause: cleanup,
                        retryable: false,
                    });
                }
            }
            throw preserveTaskError(error, task);
        }
    }

    async #dispatch(
        request: ToolCallDispatchRequest,
        execution: { task?: TaskCreationEvidence },
    ): Promise<JsonValue> {
        const {
            callId,
            execute,
            hooks,
            invocationInput,
            onProgress,
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

        const recordAudit = async (record: () => Promise<void>): Promise<void> => {
            try {
                await record();
            } catch (error) {
                this.#audit.abandon(callId);
                console.warn("ToolCall audit unavailable; preserving execution outcome:", error);
            }
        };

        const reportOutboundFailure = (
            phase: "progress" | "result" | "error",
            cause: unknown,
            original?: unknown,
        ): void => {
            console.warn("ToolCall outbound hook failed", {
                instance: this.#instanceName,
                callId,
                toolName: scope.toolName,
                phase,
                causeName: cause instanceof Error ? cause.name : typeof cause,
                causeCode: getErrorCode(cause, "error.unknown"),
                ...(original === undefined ? {} : {
                    originalCode: getErrorCode(original, "error.unknown"),
                }),
            });
        };

        // Establish audit ownership before asynchronous preparation. A
        // duplicate ID must fail here rather than abandon another active call.
        if (hostRecorded) await this.#audit.requested(scope);
        if (request.rejection !== undefined) {
            if (hostRecorded) await recordAudit(() => this.#audit.denied(scope, request.rejection!.code));
            throw createErrorFromBody(request.rejection);
        }

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
            if (execute === undefined) this.#assertReady();
        } catch (error) {
            if (hostRecorded) await this.#audit.failActive(scope, error);
            throw error;
        }

        const createsTask = hookValue.toolName === "bash_run" ||
            (hookValue.toolName === "task_manage" && record(innerInput)?.command === "create");
        let reservation: WorkerToolSchedulerReservation;
        try {
            reservation = this.#toolCallScheduler.reserve(
                {
                    callId,
                    instanceName: this.#instanceName,
                    ctxId: hookValue.context.ctxId,
                    source: hookValue.context.source,
                    toolName: hookValue.toolName,
                    toolCallClass: classifyToolCall(hookValue.toolName, innerInput),
                },
                signal,
            );
        } catch (error) {
            if (hostRecorded) await this.#audit.failActive(scope, error);
            throw normalizeToolSchedulerError(error);
        }
        if (hostRecorded) await recordAudit(() => this.#audit.queued(scope));

        const runningContext = this.#audit.runningContext(scope);
        let toolExecutionSucceeded = false;
        let executionStarted = false;
        let executionCompleted = false;
        let hasNativePresentation = false;
        let mutationActivityFailure: unknown;
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
                          } catch (error) {
                              failureStage = "outboundHook";
                              reportOutboundFailure("progress", error);
                              progressFailure = outboundHookFailure(false, callId);
                          }
                      });
                  };
        const flushProgress = async (): Promise<void> => {
            await progressTail;
            if (progressFailure !== undefined) throw progressFailure;
        };

        try {
            const executed = await reservation.run(async () => {
                executionStarted = true;
                if (hostRecorded)
                    await recordAudit(() => this.#audit.running(scope, runningContext));
                const ctxId = hookValue.context.ctxId;
                const recordActivity = this.#onExecutionActivity;
                // Goal control and UI/report calls are not evidence of work.
                const shouldTrack = ctxId !== undefined && recordActivity !== undefined &&
                    hookValue.context.contextMode !== "stateless" &&
                    hookValue.context.source !== "extension" &&
                    !["workspace_goal", "progress_report", "environ_info"].includes(hookValue.toolName) &&
                    !hookValue.toolName.startsWith("mcpapp_");
                let heartbeat: ReturnType<typeof setInterval> | undefined;
                let activityTail = Promise.resolve();
                let warned = false;
                const pulse = (kind: "execution" | "mutation" = "execution"): void => {
                    activityTail = activityTail.then(async () => {
                        await recordActivity!(ctxId!, kind);
                    }).catch((error: unknown) => {
                        if (kind === "mutation") {
                            mutationActivityFailure = error;
                            return;
                        }
                        if (warned) return;
                        warned = true;
                        console.warn("ToolCall Goal activity update failed:", error);
                    });
                };
                if (shouldTrack) {
                    pulse();
                    // A ToolCall can run longer than the Goal inactivity lease.
                    // Pulse only while executing; never create a background daemon.
                    heartbeat = setInterval(pulse, 20_000);
                    heartbeat.unref?.();
                }
                let appliedEdit = false;
                try {
                    const result = execute !== undefined
                        ? await execute(callId, innerInput, hookValue, signal, hookProgress)
                        : await this.#toolInvoker.invoke(
                              hookValue.toolName,
                              innerInput,
                              {
                                  ...executionContext(hookValue.context),
                                  operationId: callId,
                              },
                              signal,
                              hookProgress,
                          );
                    if (createsTask) {
                        const native = isPresentedToolCallResult(result);
                        const id = taskResultId(native ? result.result : result);
                        if (id !== undefined) {
                            const task = record(record(native ? result.result : result)?.task);
                            const state = task?.status ?? task?.state;
                            execution.task = {
                                id, start: "confirmed", completed: true, native,
                                worker: execute === undefined,
                                running: state !== "exited" && state !== "failed" && state !== "signaled",
                            };
                            if (signal?.aborted && execute === undefined)
                                throw createRemoteError({
                                    code: runtimeErrorCodes.toolCallCancelled,
                                    message: "Task creation was cancelled before its result was returned.",
                                    retryable: false,
                                });
                        }
                    }
                    appliedEdit = hookValue.toolName === "file_edit" && hasAppliedFileEdit(result);
                    return result;
                } catch (error) {
                    if (createsTask && execution.task === undefined) {
                        const details = record(toRemoteErrorBody(error)?.details);
                        const id = details?.taskId;
                        const start = details?.taskStart;
                        if (typeof id === "string" && id.length > 0 && (start === "confirmed" || start === "unknown")) {
                            // An output/serialization failure after spawn does not establish exit.
                            // Reuse the confirmed identity for late cancellation unless the
                            // Worker already observed a terminal state or requested termination.
                            execution.task = { id, start, completed: false, native: false,
                                worker: execute === undefined,
                                running: start === "confirmed" && details?.killRequested !== true &&
                                    details?.state !== "exited" && details?.state !== "failed" };
                        }
                    }
                    throw error;
                } finally {
                    if (heartbeat !== undefined) clearInterval(heartbeat);
                    // Only an applied, completed edit advances durable progress;
                    // a read, failed edit or heartbeat merely proves execution.
                    if (shouldTrack) {
                        pulse(appliedEdit ? "mutation" : "execution");
                        // A completed edit must not be reported before its
                        // progress epoch has had a chance to become durable.
                        await activityTail;
                    }
                }
            });
            executionCompleted = true;
            const presented = isPresentedToolCallResult(executed);
            const presentation: ToolCallPresentation | undefined =
                presented
                    ? executed.presentation
                    : undefined;
            hasNativePresentation = presentation !== undefined;
            const rawResult =
                presented
                    ? executed.result
                    : executed;
            if (mutationActivityFailure !== undefined) {
                failureStage = "postExecution";
                throw createRemoteError({
                    cause: mutationActivityFailure,
                    code: "goal.activityCommitFailed",
                    details: { callId, executionCompleted: true, result: rawResult },
                    message: "File edit completed, but Goal progress was not committed. Do not repeat the file edit.",
                    retryable: false,
                });
            }
            let adaptedResult: JsonValue;
            try {
                adaptedResult =
                    transformResult === undefined
                        ? rawResult
                        : await transformResult(rawResult, callId, presentation);
            } catch (error) {
                failureStage = "postExecution";
                throw error;
            }
            try {
                await flushProgress();
            } catch {
                failureStage = "outboundHook";
                throw outboundHookFailure(true, callId);
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
                            payload: presentation === undefined
                                ? adaptedResult
                                : mcpOutboundResult(adaptedResult, presentation),
                        },
                    }));
                if (hookValue.kind !== "error") {
                    if (presentation !== undefined) assertMcpOutboundResult(hookValue.payload);
                    assertTaskDelivery(execution.task, hookValue.payload, callId);
                }
            } catch (error) {
                failureStage = "outboundHook";
                reportOutboundFailure("result", error);
                throw outboundHookFailure(true, callId);
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
                await recordAudit(() => this.#audit.completed(
                    scope,
                    runningContext,
                    result,
                    bashResult,
                    async () => {
                        if (bashResult !== undefined) {
                            await this.#log.append(bashResult, runningContext);
                        }
                    },
                ));
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
                    await recordAudit(() => this.#audit.failed(
                        scope,
                        runningContext,
                        errorCode,
                        undefined,
                        async () => undefined,
                        { executionCompleted: true },
                    ));
                throw withExecutionOutcome(finalizedTerminal.error, executionCompleted, undefined, callId);
            }

            await progressTail;
            const failure = progressFailure ?? error;
            // AbortSignal.throwIfAborted() throws the signal reason itself.
            // An interrupted running tool may already have changed state.
            const interruptedByCaller = signal?.aborted === true &&
                (failure === signal.reason ||
                    (failure instanceof Error && failure.name === "AbortError"));
            const classifiedFailure = interruptedByCaller
                ? createRemoteError({
                      code: runtimeErrorCodes.toolCallCancelled,
                      message: "Tool execution was cancelled by the caller; execution effects may be uncertain.",
                      retryable: false,
                      details: { callId },
                  })
                : failure;
            const auditFailure = () =>
                executionCompleted || failureStage !== undefined
                    ? {
                          executionCompleted,
                          ...(failureStage === undefined
                              ? {}
                              : { failureStage }),
                      }
                    : undefined;
            if (failureStage === "outboundHook") {
                // A failed outbound rewrite has already consumed the safe
                // presentation path. Running it again for the new error can
                // re-enter the same broken sandbox; never expose the raw result.
                const deliveryError = outboundHookFailure(executionCompleted, callId);
                if (hostRecorded)
                    await recordAudit(() => this.#audit.failed(
                        scope,
                        runningContext,
                        getErrorCode(deliveryError, runtimeErrorCodes.providerFailed),
                        undefined,
                        async () => undefined,
                        auditFailure(),
                    ));
                throw withExecutionOutcome(deliveryError, executionCompleted, failureStage, callId);
            }
            let outerFailure: ToolCallOuterError;
            try {
                outerFailure = await rewriteToolCallError(
                    hooks,
                    callId,
                    classifiedFailure,
                    hookValue,
                );
                if (outerFailure.value.kind !== "error") {
                    if (hasNativePresentation) assertMcpOutboundResult(outerFailure.value.payload);
                    assertTaskDelivery(execution.task, outerFailure.value.payload, callId);
                }
            } catch (error) {
                failureStage = "outboundHook";
                reportOutboundFailure("error", error, failure);
                const hookError = outboundHookFailure(executionCompleted, callId);
                if (hostRecorded) {
                    await recordAudit(() => this.#audit.failed(
                        scope,
                        runningContext,
                        getErrorCode(
                            hookError,
                            runtimeErrorCodes.providerFailed,
                        ),
                        undefined,
                        async () => undefined,
                        auditFailure(),
                    ));
                }
                throw withExecutionOutcome(hookError, executionCompleted, failureStage, callId);
            }

            try {
                await runOutboundReview(hooks, {
                    callId,
                    direction: "outbound",
                    value: outerFailure.value,
                });
            } catch (error) {
                failureStage = "outboundHook";
                if (hostRecorded)
                    await recordAudit(() => this.#audit.failed(
                        scope,
                        runningContext,
                        getErrorCode(error, runtimeErrorCodes.providerFailed),
                        undefined,
                        async () => undefined,
                        auditFailure(),
                    ));
                throw withExecutionOutcome(error, executionCompleted, failureStage, callId);
            }

            if (outerFailure.value.kind !== "error") {
                const interpreted = await interpretTerminalValue(
                    outerFailure.value,
                    onProgress,
                );
                if (interpreted.error !== undefined) throw interpreted.error;
                if (hostRecorded) {
                    await recordAudit(() => this.#audit.completed(
                        scope,
                        runningContext,
                        interpreted.result!,
                        undefined,
                        async () => undefined,
                    ));
                }
                return interpreted.result!;
            }

            const rawErrorCode = getErrorCode(
                outerFailure.error,
                runtimeErrorCodes.providerFailed,
            );
            const errorCode =
                interruptedByCaller || rawErrorCode === "tool.cancelled"
                    ? runtimeErrorCodes.toolCallCancelled
                    : rawErrorCode;
            const nonRunningStatus = readNonRunningSchedulerStatus(errorCode);

            // Scheduler-shaped errors from result adaptation are failures
            // after execution, not evidence that the request never ran.
            if (nonRunningStatus !== undefined && !executionCompleted && failureStage === undefined) {
                if (hostRecorded) {
                    await recordAudit(() => this.#audit.nonRunning(
                        scope,
                        runningContext,
                        nonRunningStatus,
                        errorCode,
                    ));
                }
                // The scheduler can safely retry a never-started request.
                // Cancellation thrown by an already-running executor has a
                // different contract: effects may have happened.
                throw attachToolCallErrorPayload(
                    withExecutionOutcome(
                        normalizeToolSchedulerError(outerFailure.error),
                        executionCompleted,
                        failureStage,
                        callId,
                        executionStarted,
                    ),
                    outerFailure.payload,
                );
            }

            if (hostRecorded) {
                await recordAudit(() => this.#audit.failed(
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
                ));
            }
            throw withExecutionOutcome(outerFailure.error, executionCompleted, failureStage, callId);
        }
    }
}

interface TaskCreationEvidence {
    readonly id: string;
    readonly start: "confirmed" | "unknown";
    readonly completed: boolean;
    readonly native: boolean;
    readonly worker: boolean;
    readonly running: boolean;
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function taskResultId(value: JsonValue | undefined): string | undefined {
    const id = record(record(value)?.task)?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

function assertTaskDelivery(task: TaskCreationEvidence | undefined, value: JsonValue, callId: string): void {
    if (task === undefined) return;
    const result = task.native ? record(value)?.structuredContent : value;
    if (!task.completed || taskResultId(result) !== task.id ||
        record(result)?.error !== undefined || (task.native && record(value)?.isError === true)) {
        throw outboundHookFailure(task.completed, callId);
    }
}

function preserveTaskError(error: unknown, task: TaskCreationEvidence): Error {
    const body = toRemoteErrorBody(error);
    const details = body?.details;
    const message = task.start === "confirmed" ? "Task started" : "Task start could not be confirmed";
    const preserved = createRemoteError({
        ...body,
        code: body?.code ?? runtimeErrorCodes.providerFailed,
        details: {
            ...(record(details) ?? (details === undefined ? {} : { originalDetails: details })),
            taskId: task.id,
            taskStart: task.start,
        },
        message: `${message} (taskId=${task.id}). Inspect this task before deciding what to do (task_input without input, or task_inspect for a PTY); do not repeat the creation call. ${errorMessage(error)}`,
        retryable: false,
    });
    const payload = record(readToolCallErrorPayload(error));
    return payload === undefined ? preserved : attachToolCallErrorPayload(preserved, {
        ...payload,
        error: preserved.toBody() as unknown as JsonValue,
    });
}

function hasAppliedFileEdit(value: JsonValue | ToolCallPresentedResult): boolean {
    const result = isPresentedToolCallResult(value) ? value.result : value;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
    const operations = result.operations;
    return Array.isArray(operations) && operations.some((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
        entry.status === "applied");
}

function withExecutionOutcome(
    error: unknown,
    completed: boolean,
    stage?: ToolCallFailureStage,
    callId?: string,
    started = completed,
): Error {
    if (!started && !completed && stage === undefined)
        return error instanceof Error ? error : new Error(String(error));
    const body = toRemoteErrorBody(error);
    const details = body?.details;
    const errorCode = getErrorCode(error, runtimeErrorCodes.providerFailed);
    return createRemoteError({
        code: errorCode === "tool.cancelled" ? runtimeErrorCodes.toolCallCancelled : errorCode,
        cause: error,
        details: {
            ...(details !== null && typeof details === "object" && !Array.isArray(details)
                ? details : {}),
            ...(callId === undefined ? {} : { callId }),
            executionCompleted: completed,
            ...(stage === undefined ? {} : { failureStage: stage }),
        },
        message: errorMessage(error),
        retryable: !started && !completed && body?.retryable === true,
    });
}

function isPresentedToolCallResult(
    value: JsonValue | ToolCallPresentedResult,
): value is ToolCallPresentedResult {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        value.type === "presented-tool-call-result" &&
        typeof value.presentation === "object" &&
        value.presentation !== null &&
        "result" in value
    );
}

interface ToolCallOuterError {
    readonly error: Error;
    readonly payload: JsonValue;
    readonly result?: CommandResult;
    readonly value: ToolCallHookValue;
}

async function rewriteToolCallError(
    hooks: ToolCallHookSequenceApi,
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

function outboundHookFailure(executionCompleted: boolean, callId: string): Error {
    return createRemoteError({
        code: executionCompleted
            ? runtimeErrorCodes.toolResultDeliveryFailed
            : runtimeErrorCodes.providerFailed,
        details: { callId, executionCompleted, failureStage: "outboundHook" },
        message: executionCompleted
            ? "Tool execution completed, but its result could not be delivered safely. Do not repeat the operation."
            : "ToolCall outbound hook failed before execution completed.",
        retryable: false,
    });
}

const DEFAULT_TASK_INPUT_WAIT_MS = 5_000;

function isTaskWaitObservation(toolName: string, input: JsonValue): boolean {
    if (toolName !== "task_input") return false;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return false;
    }
    const textInput = input.input;
    const noInput =
        textInput === undefined ||
        textInput === null ||
        (typeof textInput === "string" && textInput.length === 0);
    if (!noInput) return false;

    const untilExit = input.untilExit === true;
    const rawWaitMs = input.waitMs;
    const effectiveWaitMs =
        rawWaitMs === undefined || rawWaitMs === null
            ? DEFAULT_TASK_INPUT_WAIT_MS
            : typeof rawWaitMs === "number" &&
                Number.isSafeInteger(rawWaitMs) &&
                rawWaitMs >= 0
              ? rawWaitMs
              : 0;
    return (untilExit && effectiveWaitMs > 0) || effectiveWaitMs > DEFAULT_TASK_INPUT_WAIT_MS;
}

/** Classify a tool call for WorkerToolCallScheduler capacity accounting. */
export function classifyToolCall(
    toolName: string,
    input: JsonValue,
): WorkerToolSchedulerCallClass {
    if (isTaskWaitObservation(toolName, input)) return "observation";
    return isUrgentTool(toolName) ? "urgent" : "standard";
}
