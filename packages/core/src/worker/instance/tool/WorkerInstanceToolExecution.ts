import { errorCodes, type InstanceName, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import type { WorkerToolInvoker } from "../../tool/WorkerToolInvoker.js";
import type { WorkerToolCallScheduler, WorkerToolSchedulerReservation } from "../../tool/WorkerToolCallScheduler.js";
import { getErrorCode } from "../WorkerInstanceError.js";
import type { WorkerInstanceToolApproval } from "./WorkerInstanceToolApproval.js";
import type { WorkerInstanceToolAudit } from "./WorkerInstanceToolAudit.js";
import type { WorkerInstanceToolLog } from "./WorkerInstanceToolLog.js";
import {
    normalizeToolSchedulerError,
    readNonRunningSchedulerStatus,
    throwIfToolCallAborted
} from "./WorkerInstanceToolError.js";
import { asBashToolResult, asCommandResult } from "./WorkerInstanceToolResult.js";

interface WorkerInstanceToolExecutionOptions {
    approval: WorkerInstanceToolApproval;
    assertReady(): void;
    audit: WorkerInstanceToolAudit;
    instanceName: InstanceName;
    log: WorkerInstanceToolLog;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstanceToolExecution {
    readonly #approval: WorkerInstanceToolApproval;
    readonly #assertReady: WorkerInstanceToolExecutionOptions["assertReady"];
    readonly #audit: WorkerInstanceToolAudit;
    readonly #instanceName: InstanceName;
    readonly #log: WorkerInstanceToolLog;
    readonly #toolCallScheduler: WorkerToolCallScheduler;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(options: WorkerInstanceToolExecutionOptions) {
        this.#approval = options.approval;
        this.#assertReady = options.assertReady;
        this.#audit = options.audit;
        this.#instanceName = options.instanceName;
        this.#log = options.log;
        this.#toolCallScheduler = options.toolCallScheduler;
        this.#toolInvoker = options.toolInvoker;
    }

    async call(toolName: string, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        this.#assertReady();
        throwIfToolCallAborted(signal);

        const scope = this.#audit.createScope(toolName, input, context);
        let reservation: WorkerToolSchedulerReservation;

        try {
            reservation = this.#toolCallScheduler.reserve(
                {
                    callId: scope.callId,
                    instanceName: this.#instanceName,
                    ctxId: context.ctxId,
                    source: context.source,
                    toolName
                },
                signal
            );
        } catch (error) {
            throw normalizeToolSchedulerError(error);
        }

        let approvalState: Awaited<ReturnType<WorkerInstanceToolApproval["prepare"]>>;
        try {
            await this.#audit.queued(scope);
            approvalState = await this.#approval.prepare(
                scope.callId,
                scope.toolName,
                scope.inputSummary,
                scope.context,
                scope.startedAt,
                () => reservation.markPendingApproval(),
                signal
            );
        } catch (error) {
            reservation.release();
            await this.#audit.failActive(scope, error);
            throw error;
        }

        const runningContext = this.#audit.runningContext(scope, approvalState);
        let toolExecutionSucceeded = false;

        try {
            const result = await reservation.run(async () => {
                await this.#audit.running(scope, runningContext, approvalState);
                return await this.#toolInvoker.invoke(toolName, input, context, signal);
            });
            toolExecutionSucceeded = true;
            const bashResult = toolName === "bash_run" ? asBashToolResult(result) : undefined;
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
                }
            );
            return result;
        } catch (error) {
            if (toolExecutionSucceeded) {
                throw error;
            }

            const rawErrorCode = getErrorCode(error, errorCodes.coreProviderFailed);
            const errorCode = rawErrorCode === "tool.cancelled" ? errorCodes.coreToolCallCancelled : rawErrorCode;
            const nonRunningStatus = readNonRunningSchedulerStatus(errorCode);

            if (nonRunningStatus !== undefined) {
                await this.#audit.nonRunning(scope, runningContext, approvalState, nonRunningStatus, errorCode);
                throw normalizeToolSchedulerError(error);
            }

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
                }
            );
            throw error;
        }
    }
}
