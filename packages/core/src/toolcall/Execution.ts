import {
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

interface ToolCallExecutionOptions {
    approval: ToolCallApproval;
    assertReady(): void;
    audit: WorkerInstanceToolAudit;
    instanceName: InstanceName;
    log: WorkerInstanceToolLog;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class ToolCallExecution {
    readonly #approval: ToolCallApproval;
    readonly #assertReady: ToolCallExecutionOptions["assertReady"];
    readonly #audit: WorkerInstanceToolAudit;
    readonly #instanceName: InstanceName;
    readonly #log: WorkerInstanceToolLog;
    readonly #toolCallScheduler: WorkerToolCallScheduler;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(options: ToolCallExecutionOptions) {
        this.#approval = options.approval;
        this.#assertReady = options.assertReady;
        this.#audit = options.audit;
        this.#instanceName = options.instanceName;
        this.#log = options.log;
        this.#toolCallScheduler = options.toolCallScheduler;
        this.#toolInvoker = options.toolInvoker;
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
        } catch (error) {
            throw normalizeToolSchedulerError(error);
        }

        let approvalState: Awaited<
            ReturnType<ToolCallApproval["prepare"]>
        >;
        try {
            if (hostRecorded) await this.#audit.queued(scope);
            approvalState = await this.#approval.prepare(
                scope.callId,
                scope.toolName,
                scope.inputSummary,
                scope.context,
                scope.startedAt,
                () => reservation.markPendingApproval(),
                signal,
                recording,
            );
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
