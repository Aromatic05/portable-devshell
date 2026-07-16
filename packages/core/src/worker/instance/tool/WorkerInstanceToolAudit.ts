import {
    errorCodes,
    type CommandResult,
    type JsonValue,
    type ToolCallApprovalDecision,
    type ToolCallAssociation,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallRecord
} from "@portable-devshell/shared";

import type { AuditToolCallHistory } from "../../../audit/tool/AuditToolCallHistory.js";
import type { InstanceEventInput } from "../../../instance/event/InstanceEventBuffer.js";
import { getErrorCode } from "../WorkerInstanceError.js";
import { toEventData } from "../WorkerInstanceEvent.js";
import { createWorkerInstanceToolCallScope, type WorkerInstanceToolCallScope } from "./WorkerInstanceToolContext.js";
import type { WorkerInstanceBashToolResult } from "./WorkerInstanceToolResult.js";
import { commandResultOutput, readByteLength } from "./WorkerInstanceToolResult.js";
import { throwIfToolCallAborted } from "./WorkerInstanceToolError.js";

interface WorkerInstanceToolAuditOptions {
    appendEvent(type: InstanceEventInput["type"], data?: JsonValue): Promise<unknown>;
    toolCallAssociationProvider?: () => ToolCallAssociation | undefined;
    toolCallHistory: AuditToolCallHistory;
}

export type WorkerInstanceToolApprovalState = {
    approvalId?: string;
    decision?: ToolCallApprovalDecision;
};

export type WorkerInstanceToolRunningContext = WorkerInstanceToolCallScope["eventContext"] & {
    approvalId?: string;
};

export class WorkerInstanceToolAudit {
    readonly #appendEvent: WorkerInstanceToolAuditOptions["appendEvent"];
    readonly #toolCallAssociationProvider?: () => ToolCallAssociation | undefined;
    readonly #toolCallHistory: AuditToolCallHistory;

    constructor(options: WorkerInstanceToolAuditOptions) {
        this.#appendEvent = options.appendEvent;
        this.#toolCallAssociationProvider = options.toolCallAssociationProvider;
        this.#toolCallHistory = options.toolCallHistory;
    }

    createScope(toolName: string, input: JsonValue, context: ToolCallContext): WorkerInstanceToolCallScope {
        return createWorkerInstanceToolCallScope(toolName, input, context, this.#toolCallAssociationProvider?.());
    }

    runningContext(
        scope: WorkerInstanceToolCallScope,
        approvalState: WorkerInstanceToolApprovalState
    ): WorkerInstanceToolRunningContext {
        return {
            ...scope.eventContext,
            ...(approvalState.approvalId === undefined ? {} : { approvalId: approvalState.approvalId })
        };
    }

    async queued(scope: WorkerInstanceToolCallScope): Promise<void> {
        await this.#toolCallHistory.started(
            scope.callId,
            scope.toolName,
            scope.inputSummary,
            scope.context,
            scope.startedAt,
            "queued",
            scope.association,
            scope.input
        );
        await this.#appendEvent(
            "toolCall.queued",
            toEventData({
                ...scope.eventContext,
                queuedAt: scope.startedAt,
                startedAt: scope.startedAt,
                status: "queued"
            })
        );
    }

    async running(
        scope: WorkerInstanceToolCallScope,
        runningContext: WorkerInstanceToolRunningContext,
        approvalState: WorkerInstanceToolApprovalState
    ): Promise<void> {
        await this.#toolCallHistory.running(scope.callId, approvalState.decision);
        await this.#appendEvent(
            "toolCall.running",
            toEventData({
                ...runningContext,
                ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                startedAt: scope.startedAt,
                status: "running"
            })
        );
    }

    async completed(
        scope: WorkerInstanceToolCallScope,
        runningContext: WorkerInstanceToolRunningContext,
        approvalState: WorkerInstanceToolApprovalState,
        result: JsonValue,
        bashResult: WorkerInstanceBashToolResult | undefined,
        appendLogs: () => Promise<void>
    ): Promise<void> {
        const completedAt = new Date().toISOString();
        await this.#toolCallHistory.completed(scope.callId, completedAt, {
            output: result,
            ...(bashResult === undefined ? {} : {
                exitCode: bashResult.exitCode,
                stderrBytes: bashResult.stderrBytes,
                stdoutBytes: bashResult.stdoutBytes,
                termSignal: bashResult.termSignal,
                termination: bashResult.termination
            })
        });
        await appendLogs();
        await this.#appendEvent(
            "toolCall.completed",
            toEventData({
                ...runningContext,
                completedAt,
                ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                exitCode: bashResult?.exitCode,
                output: result,
                startedAt: scope.startedAt,
                status: "completed",
                stderrBytes: bashResult?.stderrBytes,
                stdoutBytes: bashResult?.stdoutBytes,
                termSignal: bashResult?.termSignal,
                termination: bashResult?.termination
            })
        );
    }

    async nonRunning(
        scope: WorkerInstanceToolCallScope,
        runningContext: WorkerInstanceToolRunningContext,
        approvalState: WorkerInstanceToolApprovalState,
        status: "queueTimeout" | "cancelled",
        errorCode: string
    ): Promise<void> {
        const completedAt = new Date().toISOString();
        if (status === "queueTimeout") {
            await this.#toolCallHistory.queueTimeout(scope.callId, errorCode, completedAt);
        } else {
            await this.#toolCallHistory.cancelled(scope.callId, errorCode, completedAt);
        }
        await this.#appendEvent(
            status === "queueTimeout" ? "toolCall.queueTimeout" : "toolCall.cancelled",
            toEventData({
                ...runningContext,
                completedAt,
                errorCode,
                ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                startedAt: scope.startedAt,
                status
            })
        );
    }

    async failed(
        scope: WorkerInstanceToolCallScope,
        runningContext: WorkerInstanceToolRunningContext,
        approvalState: WorkerInstanceToolApprovalState,
        errorCode: string,
        result: CommandResult | undefined,
        appendLogs: () => Promise<void>
    ): Promise<void> {
        const completedAt = new Date().toISOString();
        await appendLogs();
        await this.#toolCallHistory.failed(
            scope.callId,
            errorCode,
            completedAt,
            result === undefined
                ? undefined
                : {
                      exitCode: result.exitCode,
                      output: commandResultOutput(result),
                      stderrBytes: readByteLength(result.stderr),
                      stdoutBytes: readByteLength(result.stdout)
                  }
        );
        await this.#appendEvent(
            "toolCall.failed",
            toEventData({
                ...runningContext,
                completedAt,
                ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                errorCode,
                exitCode: result?.exitCode,
                output: result === undefined ? undefined : commandResultOutput(result),
                startedAt: scope.startedAt,
                status: "failed",
                stderrBytes: result === undefined ? undefined : readByteLength(result.stderr),
                stdoutBytes: result === undefined ? undefined : readByteLength(result.stdout)
            })
        );
    }

    async failActive(scope: WorkerInstanceToolCallScope, error: unknown): Promise<void> {
        if (!this.#toolCallHistory.hasActive(scope.callId)) {
            return;
        }

        await this.#toolCallHistory.failed(
            scope.callId,
            getErrorCode(error, errorCodes.coreProviderFailed),
            new Date().toISOString()
        ).catch(() => undefined);
    }

    async auditOperation<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: () => Promise<T>,
        signal?: AbortSignal
    ): Promise<T> {
        throwIfToolCallAborted(signal);
        const scope = this.createScope(toolName, input, context);

        await this.#toolCallHistory.started(
            scope.callId,
            scope.toolName,
            scope.inputSummary,
            scope.context,
            scope.startedAt,
            "running",
            scope.association,
            scope.input
        );
        await this.#appendEvent(
            "toolCall.running",
            toEventData({
                ...scope.eventContext,
                startedAt: scope.startedAt,
                status: "running"
            })
        );

        try {
            throwIfToolCallAborted(signal);
            const result = await operation();
            const completedAt = new Date().toISOString();
            await this.#toolCallHistory.completed(scope.callId, completedAt, { output: result });
            await this.#appendEvent(
                "toolCall.completed",
                toEventData({
                    ...scope.eventContext,
                    completedAt,
                    output: result,
                    startedAt: scope.startedAt,
                    status: "completed"
                })
            );
            return result;
        } catch (error) {
            const completedAt = new Date().toISOString();
            const errorCode = getErrorCode(error, errorCodes.coreProviderFailed);
            const cancelled = errorCode === errorCodes.coreToolCallCancelled || errorCode === "tool.cancelled";

            if (cancelled) {
                await this.#toolCallHistory.cancelled(scope.callId, errorCodes.coreToolCallCancelled, completedAt);
                await this.#appendEvent(
                    "toolCall.cancelled",
                    toEventData({
                        ...scope.eventContext,
                        completedAt,
                        errorCode: errorCodes.coreToolCallCancelled,
                        startedAt: scope.startedAt,
                        status: "cancelled"
                    })
                );
            } else {
                await this.#toolCallHistory.failed(scope.callId, errorCode, completedAt);
                await this.#appendEvent(
                    "toolCall.failed",
                    toEventData({
                        ...scope.eventContext,
                        completedAt,
                        errorCode,
                        startedAt: scope.startedAt,
                        status: "failed"
                    })
                );
            }
            throw error;
        }
    }

    async read(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#toolCallHistory.read(query);
    }
}
