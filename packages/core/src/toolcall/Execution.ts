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
import type { ToolCallApproval } from "./Approval.js";
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
    ToolCallBoundarySequence,
    type ToolCallBoundaryProvider,
} from "./boundary/Sequence.js";
import type { ToolCallBoundaryContext } from "./boundary/Review.js";
import { snapshotJson } from "./boundary/Snapshot.js";

interface ToolCallExecutionOptions {
    approval: ToolCallApproval;
    boundary?: ToolCallBoundaryProvider;
    assertReady(): void;
    audit: WorkerInstanceToolAudit;
    instanceName: InstanceName;
    log: WorkerInstanceToolLog;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class ToolCallExecution {
    readonly #approval: ToolCallApproval;
    #boundary: ToolCallBoundaryProvider;
    #boundaryBound: boolean;
    readonly #assertReady: ToolCallExecutionOptions["assertReady"];
    readonly #audit: WorkerInstanceToolAudit;
    readonly #instanceName: InstanceName;
    readonly #log: WorkerInstanceToolLog;
    readonly #toolCallScheduler: WorkerToolCallScheduler;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(options: ToolCallExecutionOptions) {
        this.#approval = options.approval;
        this.#boundary = options.boundary ?? emptyToolCallBoundaryProvider;
        this.#boundaryBound = options.boundary !== undefined;
        this.#assertReady = options.assertReady;
        this.#audit = options.audit;
        this.#instanceName = options.instanceName;
        this.#log = options.log;
        this.#toolCallScheduler = options.toolCallScheduler;
        this.#toolInvoker = options.toolInvoker;
    }

    bindBoundary(boundary: ToolCallBoundaryProvider): void {
        if (this.#boundaryBound)
            throw new Error("ToolCall Boundary is already bound.");
        this.#boundary = boundary;
        this.#boundaryBound = true;
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
        onFeedback?: (feedback: readonly string[]) => void,
        afterReview?: (callId: string) => Promise<void> | void,
    ): Promise<JsonValue> {
        return await this.#call(
            toolName,
            input,
            context,
            signal,
            transformResult,
            invocationInput,
            onProgress,
            recording,
            onFeedback,
            async (callId) => {
                await afterReview?.(callId);
                this.#assertReady();
            },
            async (
                innerInput,
                callId,
                boundaryProgress,
                executionSignal,
                executionContext,
            ) =>
                await this.#toolInvoker.invoke(
                    toolName,
                    innerInput,
                    { ...executionContext, operationId: callId },
                    executionSignal,
                    boundaryProgress,
                ),
        );
    }

    async callOperation<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string, input: JsonValue) => Promise<T>,
        signal?: AbortSignal,
        onFeedback?: (feedback: readonly string[]) => void,
        afterReview?: (callId: string) => Promise<void> | void,
    ): Promise<T> {
        return (await this.#call(
            toolName,
            input,
            context,
            signal,
            undefined,
            undefined,
            undefined,
            "host",
            onFeedback,
            afterReview,
            async (innerInput, callId) => await operation(callId, innerInput),
        )) as T;
    }

    async #call(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal: AbortSignal | undefined,
        transformResult:
            | ((result: JsonValue, callId: string) => Promise<JsonValue>)
            | undefined,
        invocationInput:
            | ((input: JsonValue) => Promise<JsonValue> | JsonValue)
            | undefined,
        onProgress: ((progress: JsonValue) => void) | undefined,
        recording: "caller" | "host",
        onFeedback: ((feedback: readonly string[]) => void) | undefined,
        afterReview: ((callId: string) => Promise<void> | void) | undefined,
        execute: (
            input: JsonValue,
            callId: string,
            onProgress: ((progress: JsonValue) => void) | undefined,
            signal: AbortSignal | undefined,
            context: ToolCallContext,
        ) => Promise<JsonValue>,
    ): Promise<JsonValue> {
        throwIfToolCallAborted(signal);

        const canonicalInput = snapshotJson(input);
        const canonicalContext = Object.freeze({ ...context });
        const scope = this.#audit.createScope(
            toolName,
            canonicalInput,
            canonicalContext,
        );
        const hostRecorded = recording === "host";
        const boundarySignal = signal ?? new AbortController().signal;
        const boundaryContext: ToolCallBoundaryContext = Object.freeze({
            ...canonicalContext,
            instance: this.#instanceName,
        });
        if (hostRecorded) await this.#audit.requested(scope);

        let boundaryLease;
        try {
            boundaryLease = await this.#boundary(boundaryContext);
        } catch (error) {
            if (hostRecorded) await this.#audit.failActive(scope, error);
            throw error;
        }
        const boundary = boundaryLease.sequence;

        try {
            let review;
            try {
                review = await boundary.review({
                    context: boundaryContext,
                    direction: "inbound",
                    kind: "call",
                    payload: canonicalInput,
                    signal: boundarySignal,
                    toolName,
                });
                deliverFeedback(review.feedback, onFeedback);
            } catch (error) {
                if (hostRecorded) await this.#audit.failActive(scope, error);
                throw error;
            }

            if (review.decision === "reject") {
                const rejectionMessage =
                    review.reason ??
                    `Tool call ${toolName} was rejected by review.`;
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
                        toolName,
                    },
                    message: rejectionMessage,
                    retryable: false,
                });
                if (hostRecorded)
                    await this.#audit.denied(
                        scope,
                        errorCodes.coreToolCallRejected,
                    );
                throw error;
            }

            let reservation: WorkerToolSchedulerReservation;
            try {
                reservation = this.#toolCallScheduler.reserve(
                    {
                        callId: scope.callId,
                        instanceName: this.#instanceName,
                        ctxId: canonicalContext.ctxId,
                        source: canonicalContext.source,
                        toolName,
                    },
                    signal,
                );
            } catch (error) {
                if (hostRecorded) await this.#audit.failActive(scope, error);
                throw normalizeToolSchedulerError(error);
            }

            try {
                await afterReview?.(scope.callId);
            } catch (error) {
                reservation.release();
                if (hostRecorded) await this.#audit.failActive(scope, error);
                throw error;
            }
            if (hostRecorded) await this.#audit.queued(scope);

            let approvalState: Awaited<
                ReturnType<ToolCallApproval["prepare"]>
            >;
            try {
                approvalState = await this.#approval.prepare({
                    callId: scope.callId,
                    context: scope.context,
                    inputSummary: scope.inputSummary,
                    onPendingApproval: () => reservation.markPendingApproval(),
                    recording,
                    required: review.decision === "approve",
                    signal,
                    startedAt: scope.startedAt,
                    toolName: scope.toolName,
                });
            } catch (error) {
                reservation.release();
                if (hostRecorded) await this.#audit.failActive(scope, error);
                throw error;
            }

            const runningContext = this.#audit.runningContext(
                scope,
                approvalState,
            );
            let toolExecutionSucceeded = false;
            let executionCompleted = false;
            let failureStage: ToolCallFailureStage | undefined;
            let progressTail = Promise.resolve();
            let progressFailure: unknown;
            const boundaryProgress =
                onProgress === undefined
                    ? undefined
                    : (progress: JsonValue): void => {
                          progressTail = progressTail.then(async () => {
                              if (progressFailure !== undefined) return;
                              try {
                                  const outerProgress = await boundary.rewrite({
                                      context: boundaryContext,
                                      direction: "outbound",
                                      kind: "progress",
                                      payload: progress,
                                      signal: boundarySignal,
                                      toolName,
                                  });
                                  await deliverOutboundReviewFeedback(
                                      boundary,
                                      {
                                          context: boundaryContext,
                                          direction: "outbound",
                                          kind: "progress",
                                          payload: outerProgress,
                                          signal: boundarySignal,
                                          toolName,
                                      },
                                      onFeedback,
                                  );
                                  try {
                                      onProgress(outerProgress);
                                  } catch (error) {
                                      console.warn(
                                          error instanceof Error
                                              ? error
                                              : new Error(String(error)),
                                      );
                                  }
                              } catch {
                                  failureStage = "outboundBoundary";
                                  progressFailure = outboundBoundaryFailure();
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
                        await this.#audit.running(
                            scope,
                            runningContext,
                            approvalState,
                        );
                    const rewrittenInput = await boundary.rewrite({
                        context: boundaryContext,
                        direction: "inbound",
                        kind: "call",
                        payload: canonicalInput,
                        signal: boundarySignal,
                        toolName,
                    });
                    const innerInput =
                        invocationInput === undefined
                            ? rewrittenInput
                            : await invocationInput(rewrittenInput);
                    return await execute(
                        innerInput,
                        scope.callId,
                        boundaryProgress,
                        signal,
                        canonicalContext,
                    );
                });
                executionCompleted = true;
                let adaptedResult: JsonValue;
                try {
                    adaptedResult =
                        transformResult === undefined
                            ? rawResult
                            : await transformResult(rawResult, scope.callId);
                } catch (error) {
                    failureStage = "postExecution";
                    throw error;
                }
                try {
                    await flushProgress();
                } catch (error) {
                    failureStage = "outboundBoundary";
                    throw error;
                }
                let result: JsonValue;
                try {
                    result = await boundary.rewrite({
                        context: boundaryContext,
                        direction: "outbound",
                        kind: "result",
                        payload: adaptedResult,
                        signal: boundarySignal,
                        toolName,
                    });
                } catch {
                    failureStage = "outboundBoundary";
                    throw outboundBoundaryFailure();
                }
                toolExecutionSucceeded = true;
                if (hostRecorded) {
                    const bashResult =
                        toolName === "bash_run"
                            ? asBashToolResult(result)
                            : undefined;
                    await this.#audit.completed(
                        scope,
                        runningContext,
                        approvalState,
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
                await deliverOutboundReviewFeedback(
                    boundary,
                    {
                        context: boundaryContext,
                        direction: "outbound",
                        kind: "result",
                        payload: result,
                        signal: boundarySignal,
                        toolName,
                    },
                    onFeedback,
                );
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
                        boundary,
                        failure,
                        boundaryContext,
                        boundarySignal,
                        toolName,
                    );
                } catch {
                    failureStage = "outboundBoundary";
                    const boundaryError = outboundBoundaryFailure();
                    if (hostRecorded) {
                        await this.#audit.failed(
                            scope,
                            runningContext,
                            approvalState,
                            getErrorCode(
                                boundaryError,
                                errorCodes.coreProviderFailed,
                            ),
                            undefined,
                            async () => undefined,
                            auditFailure(),
                        );
                    }
                    throw boundaryError;
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
                            approvalState,
                            nonRunningStatus,
                            errorCode,
                        );
                    }
                    await deliverOutboundReviewFeedback(
                        boundary,
                        {
                            context: boundaryContext,
                            direction: "outbound",
                            kind: "error",
                            payload: outerFailure.payload,
                            signal: boundarySignal,
                            toolName,
                        },
                        onFeedback,
                    );
                    throw normalizeToolSchedulerError(outerFailure.error);
                }

                if (hostRecorded) {
                    await this.#audit.failed(
                        scope,
                        runningContext,
                        approvalState,
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
                await deliverOutboundReviewFeedback(
                    boundary,
                    {
                        context: boundaryContext,
                        direction: "outbound",
                        kind: "error",
                        payload: outerFailure.payload,
                        signal: boundarySignal,
                        toolName,
                    },
                    onFeedback,
                );
                throw outerFailure.error;
            }
        } finally {
            boundaryLease.release();
        }
    }
}

async function deliverOutboundReviewFeedback(
    boundary: ToolCallBoundarySequence,
    input: Parameters<ToolCallBoundarySequence["review"]>[0],
    onFeedback: ((feedback: readonly string[]) => void) | undefined,
): Promise<void> {
    try {
        const review = await boundary.review(input);
        deliverFeedback(review.feedback, onFeedback);
    } catch (error) {
        console.warn(error instanceof Error ? error : new Error(String(error)));
    }
}

function deliverFeedback(
    feedback: readonly string[] | undefined,
    onFeedback: ((feedback: readonly string[]) => void) | undefined,
): void {
    if (feedback === undefined || feedback.length === 0 || onFeedback === undefined)
        return;
    try {
        onFeedback(feedback);
    } catch (error) {
        console.warn(error instanceof Error ? error : new Error(String(error)));
    }
}

interface ToolCallOuterError {
    readonly error: Error;
    readonly payload: JsonValue;
    readonly result?: CommandResult;
}

async function rewriteToolCallError(
    boundary: ToolCallBoundarySequence,
    error: unknown,
    context: ToolCallBoundaryContext,
    signal: AbortSignal,
    toolName: string,
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
    const rewritten = await boundary.rewrite({
        context,
        direction: "outbound",
        kind: "error",
        payload,
        signal,
        toolName,
    });
    const record = rewritten as Record<string, JsonValue>;
    const rewrittenBody = record.error as unknown as ControlErrorBody;
    assertErrorIdentity(body, rewrittenBody);
    const rewrittenResult =
        record.commandResult === undefined
            ? undefined
            : asCommandResult(record.commandResult);
    const outerError = createErrorFromBody(rewrittenBody);
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
        payload: {
            error: rewrittenBody as unknown as JsonValue,
            ...(rewrittenResult === undefined
                ? {}
                : { commandResult: commandResultOutput(rewrittenResult) }),
        },
        ...(rewrittenResult === undefined ? {} : { result: rewrittenResult }),
    };
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

function assertErrorIdentity(
    original: ControlErrorBody,
    rewritten: ControlErrorBody,
): void {
    if (
        original.code !== rewritten.code ||
        original.retryable !== rewritten.retryable ||
        (original.cause === undefined) !== (rewritten.cause === undefined)
    ) {
        throw new TypeError("ToolCall rewrite changed error identity.");
    }
    if (original.cause !== undefined && rewritten.cause !== undefined)
        assertErrorIdentity(original.cause, rewritten.cause);
}

function outboundBoundaryFailure(): Error {
    return createError({
        code: errorCodes.coreProviderFailed,
        message: "ToolCall outbound boundary failed.",
        retryable: false,
    });
}

const emptyToolCallBoundary = new ToolCallBoundarySequence();
const emptyToolCallBoundaryProvider: ToolCallBoundaryProvider = () => ({
    release() {},
    sequence: emptyToolCallBoundary,
});
