import {
    createError,
    errorCodes,
    type InstanceName,
    type JsonValue,
    type ToolCallContext,
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
import { asBashToolResult, asCommandResult } from "../worker/instance/tool/record/Result.js";
import { ToolCallBoundarySequence } from "./boundary/Sequence.js";

interface ToolCallExecutionOptions {
    approval: ToolCallApproval;
    boundary?: () => ToolCallBoundarySequence;
    assertReady(): void;
    audit: WorkerInstanceToolAudit;
    instanceName: InstanceName;
    log: WorkerInstanceToolLog;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class ToolCallExecution {
    readonly #approval: ToolCallApproval;
    #boundary: () => ToolCallBoundarySequence;
    #boundaryBound: boolean;
    readonly #assertReady: ToolCallExecutionOptions["assertReady"];
    readonly #audit: WorkerInstanceToolAudit;
    readonly #instanceName: InstanceName;
    readonly #log: WorkerInstanceToolLog;
    readonly #toolCallScheduler: WorkerToolCallScheduler;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(options: ToolCallExecutionOptions) {
        this.#approval = options.approval;
        this.#boundary = options.boundary ?? (() => emptyToolCallBoundary);
        this.#boundaryBound = options.boundary !== undefined;
        this.#assertReady = options.assertReady;
        this.#audit = options.audit;
        this.#instanceName = options.instanceName;
        this.#log = options.log;
        this.#toolCallScheduler = options.toolCallScheduler;
        this.#toolInvoker = options.toolInvoker;
    }

    bindBoundary(boundary: () => ToolCallBoundarySequence): void {
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
        invocationInput: JsonValue = input,
        onProgress?: (progress: JsonValue) => void,
        recording: "caller" | "host" = "host",
    ): Promise<JsonValue> {
        this.#assertReady();
        throwIfToolCallAborted(signal);

        const scope = this.#audit.createScope(toolName, input, context);
        const hostRecorded = recording === "host";
        if (hostRecorded) await this.#audit.requested(scope);

        let review;
        try {
            review = await this.#boundary().review({
                context,
                direction: "inbound",
                kind: "call",
                payload: input,
                signal: signal ?? new AbortController().signal,
                toolName,
            });
        } catch (error) {
            if (hostRecorded) await this.#audit.failActive(scope, error);
            throw error;
        }

        if (review.decision === "reject") {
            const error = createError({
                code: errorCodes.coreToolCallRejected,
                details: {
                    ...(review.reason === undefined
                        ? {}
                        : { reason: review.reason }),
                    toolName,
                },
                message:
                    review.reason ?? `Tool call ${toolName} was rejected by review.`,
                retryable: false,
            });
            if (hostRecorded)
                await this.#audit.denied(scope, errorCodes.coreToolCallRejected);
            throw error;
        }

        let reservation: WorkerToolSchedulerReservation;
        try {
            reservation = this.#toolCallScheduler.reserve(
                {
                    callId: scope.callId,
                    instanceName: this.#instanceName,
                    ctxId: context.ctxId,
                    source: context.source,
                    toolName,
                },
                signal,
            );
            if (hostRecorded) await this.#audit.queued(scope);
        } catch (error) {
            if (hostRecorded) await this.#audit.failActive(scope, error);
            throw normalizeToolSchedulerError(error);
        }

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

        const runningContext = this.#audit.runningContext(scope, approvalState);
        let toolExecutionSucceeded = false;

        try {
            const rawResult = await reservation.run(async () => {
                if (hostRecorded)
                    await this.#audit.running(
                        scope,
                        runningContext,
                        approvalState,
                    );
                return await this.#toolInvoker.invoke(
                    toolName,
                    invocationInput,
                    { ...context, operationId: scope.callId },
                    signal,
                    onProgress,
                );
            });
            const result =
                transformResult === undefined
                    ? rawResult
                    : await transformResult(rawResult, scope.callId);
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
                            await this.#log.append(bashResult, runningContext);
                        }
                    },
                );
            }
            return result;
        } catch (error) {
            if (toolExecutionSucceeded) {
                throw error;
            }

            const rawErrorCode = getErrorCode(
                error,
                errorCodes.coreProviderFailed,
            );
            const errorCode =
                rawErrorCode === "tool.cancelled"
                    ? errorCodes.coreToolCallCancelled
                    : rawErrorCode;
            const nonRunningStatus = readNonRunningSchedulerStatus(errorCode);

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
                throw normalizeToolSchedulerError(error);
            }

            if (hostRecorded) {
                const result = asCommandResult(error);
                await this.#audit.failed(
                    scope,
                    runningContext,
                    approvalState,
                    errorCode,
                    result,
                    async () => {
                        if (result !== undefined) {
                            await this.#log.append(result, runningContext);
                        }
                    },
                );
            }
            throw error;
        }
    }
}

const emptyToolCallBoundary = new ToolCallBoundarySequence();
