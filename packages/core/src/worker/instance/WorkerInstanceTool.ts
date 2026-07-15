import { randomUUID } from "node:crypto";

import {
    createError,
    errorCodes,
    type ApprovalDecision,
    type ApprovalRequest,
    type CommandResult,
    type InstanceName,
    type JsonValue,
    type ToolCallApprovalDecision,
    type ToolCallAssociation,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallRecord
} from "@portable-devshell/shared";

import type { ApprovalManager } from "../../approval/ApprovalInfra.js";
import type { InstanceEventInput } from "../../log/LogEventBuffer.js";
import type { LogQuery } from "../../log/LogQuery.js";
import type { InstanceLogEntry } from "../../log/store/LogStoreInstance.js";
import type { InstanceLogStore } from "../../log/store/LogStoreInstance.js";
import type { ToolCallHistory } from "../../log/LogToolCallHistory.js";
import type { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import type { ToolCallScheduler, ToolSchedulerReservation } from "../tool/ToolCallScheduler.js";
import { getErrorCode, readCommandDiagnostic } from "./WorkerInstanceError.js";
import { toEventData } from "./WorkerInstanceEvent.js";
import { WorkerInstanceApproval } from "./WorkerInstanceApproval.js";

interface WorkerToolOptions {
    approvalManager: ApprovalManager;
    appendEvent(type: InstanceEventInput["type"], data?: JsonValue): Promise<unknown>;
    assertReady(): void;
    instanceName: InstanceName;
    logStore: InstanceLogStore;
    toolCallAssociationProvider?: () => ToolCallAssociation | undefined;
    toolCallHistory: ToolCallHistory;
    toolCallScheduler: ToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstanceTool {
    readonly #appendEvent: WorkerToolOptions["appendEvent"];
    readonly #approval: WorkerInstanceApproval;
    readonly #assertReady: WorkerToolOptions["assertReady"];
    readonly #instanceName: InstanceName;
    readonly #logStore: InstanceLogStore;
    readonly #toolCallAssociationProvider?: () => ToolCallAssociation | undefined;
    readonly #toolCallHistory: ToolCallHistory;
    readonly #toolCallScheduler: ToolCallScheduler;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(options: WorkerToolOptions) {
        this.#appendEvent = options.appendEvent;
        this.#approval = new WorkerInstanceApproval({
            approvalManager: options.approvalManager,
            appendEvent: options.appendEvent,
            toolCallHistory: options.toolCallHistory
        });
        this.#assertReady = options.assertReady;
        this.#instanceName = options.instanceName;
        this.#logStore = options.logStore;
        this.#toolCallAssociationProvider = options.toolCallAssociationProvider;
        this.#toolCallHistory = options.toolCallHistory;
        this.#toolCallScheduler = options.toolCallScheduler;
        this.#toolInvoker = options.toolInvoker;
    }

    async call(toolName: string, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        this.#assertReady();
        throwIfAborted(signal);

        const callId = randomUUID();
        const startedAt = new Date().toISOString();
        const inputSummary = toInputSummary(input);
        const association = this.#toolCallAssociationProvider?.();
        const eventContext = {
            callId,
            input,
            inputSummary,
            requestId: context.requestId,
            ctxId: context.ctxId,
            source: context.source,
            taskId: association?.taskId,
            todoItemId: association?.todoItemId,
            toolName
        } as const;

        let reservation: ToolSchedulerReservation;

        try {
            reservation = this.#toolCallScheduler.reserve(
                {
                    callId,
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

        let approvalState: { approvalId?: string; decision?: ToolCallApprovalDecision };

        try {
            await this.#toolCallHistory.started(callId, toolName, inputSummary, context, startedAt, "queued", association, input);
            await this.#appendEvent(
                "toolCall.queued",
                toEventData({
                    ...eventContext,
                    queuedAt: startedAt,
                    startedAt,
                    status: "queued"
                })
            );

            approvalState = await this.#approval.prepare(
                callId,
                toolName,
                inputSummary,
                context,
                startedAt,
                () => reservation.markPendingApproval(),
                signal
            );
        } catch (error) {
            reservation.release();
            if (this.#toolCallHistory.hasActive(callId)) {
                const failedAt = new Date().toISOString();
                const errorCode = getErrorCode(error, errorCodes.coreProviderFailed);
                await this.#toolCallHistory.failed(callId, errorCode, failedAt).catch(() => undefined);
            }
            throw error;
        }

        const runningContext = {
            ...eventContext,
            ...(approvalState.approvalId === undefined ? {} : { approvalId: approvalState.approvalId })
        };

        let toolExecutionSucceeded = false;
        try {
            const result = await reservation.run(async () => {
                await this.#toolCallHistory.running(callId, approvalState.decision);
                await this.#appendEvent(
                    "toolCall.running",
                    toEventData({
                        ...runningContext,
                        ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                        startedAt,
                        status: "running"
                    })
                );
                return await this.#toolInvoker.invoke(toolName, input, context, signal);
            });
            toolExecutionSucceeded = true;
            const bashResult = toolName === "bash_run" ? asBashToolResult(result) : undefined;
            const completedAt = new Date().toISOString();
            await this.#toolCallHistory.completed(
                callId,
                completedAt,
                bashResult === undefined ? undefined : {
                    exitCode: bashResult.exitCode,
                    stderrBytes: bashResult.stderrBytes,
                    stdoutBytes: bashResult.stdoutBytes,
                    termSignal: bashResult.termSignal,
                    termination: bashResult.termination
                }
            );
            if (bashResult !== undefined) {
                await this.#appendToolLogs(bashResult, runningContext);
            }
            await this.#appendEvent(
                "toolCall.completed",
                toEventData({
                    ...runningContext,
                    completedAt,
                    ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                    exitCode: bashResult?.exitCode,
                    startedAt,
                    status: "completed",
                    stderrBytes: bashResult?.stderrBytes,
                    stdoutBytes: bashResult?.stdoutBytes,
                    termSignal: bashResult?.termSignal,
                    termination: bashResult?.termination
                })
            );
            return result;
        } catch (error) {
            if (toolExecutionSucceeded) {
                throw error;
            }
            const finishedAt = new Date().toISOString();
            const rawErrorCode = getErrorCode(error, errorCodes.coreProviderFailed);
            const errorCode = rawErrorCode === "tool.cancelled" ? errorCodes.coreToolCallCancelled : rawErrorCode;
            const result = asCommandResult(error);
            const nonRunningStatus = readNonRunningSchedulerStatus(errorCode);

            if (nonRunningStatus !== undefined) {
                if (nonRunningStatus === "queueTimeout") {
                    await this.#toolCallHistory.queueTimeout(callId, errorCode, finishedAt);
                } else {
                    await this.#toolCallHistory.cancelled(callId, errorCode, finishedAt);
                }
                const eventType = nonRunningStatus === "queueTimeout" ? "toolCall.queueTimeout" : "toolCall.cancelled";
                await this.#appendEvent(
                    eventType,
                    toEventData({
                        ...runningContext,
                        completedAt: finishedAt,
                        errorCode,
                        ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                        startedAt,
                        status: nonRunningStatus
                    })
                );
                throw normalizeToolSchedulerError(error);
            }

            if (result !== undefined) {
                await this.#appendToolLogs(result, runningContext);
            }
            await this.#toolCallHistory.failed(
                callId,
                errorCode,
                finishedAt,
                result === undefined
                    ? undefined
                    : {
                          exitCode: result.exitCode,
                          stderrBytes: readByteLength(result.stderr),
                          stdoutBytes: readByteLength(result.stdout)
                      }
            );
            await this.#appendEvent(
                "toolCall.failed",
                toEventData({
                    ...runningContext,
                    completedAt: finishedAt,
                    ...(approvalState.decision === undefined ? {} : { decision: approvalState.decision }),
                    errorCode,
                    exitCode: result?.exitCode,
                    startedAt,
                    status: "failed",
                    stderrBytes: result === undefined ? undefined : readByteLength(result.stderr),
                    stdoutBytes: result === undefined ? undefined : readByteLength(result.stdout)
                })
            );
            throw error;
        }
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        return await this.#approval.listApprovals();
    }

    async getApproval(approvalId: string): Promise<ApprovalRequest> {
        return await this.#approval.getApproval(approvalId);
    }

    async decideApproval(
        approvalId: string,
        input: { decision: ApprovalDecision["decision"]; decidedBy: ApprovalDecision["decidedBy"]; policyPatch?: JsonValue; reason?: string; remember?: boolean }
    ): Promise<ApprovalRequest> {
        return await this.#approval.decideApproval(approvalId, input);
    }

    async readLogs(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        return await this.#logStore.read(query);
    }

    async readToolCalls(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#toolCallHistory.read(query);
    }

    async #appendToolLogs(
        result: Pick<CommandResult, "stderr" | "stdout">,
        context: {
            callId: string;
            requestId?: string;
            ctxId?: string;
            source: ToolCallContext["source"];
            toolName: string;
        }
    ): Promise<void> {
        const at = new Date().toISOString();

        if (result.stdout.length > 0) {
            await this.#logStore.append("stdout", result.stdout, at, context);
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...context,
                    bytes: readByteLength(result.stdout),
                    preview: readPreview(result.stdout),
                    stream: "stdout",
                    tail: readTail(result.stdout)
                })
            );
        }

        if (result.stderr.length > 0) {
            await this.#logStore.append("stderr", result.stderr, at, context);
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...context,
                    bytes: readByteLength(result.stderr),
                    preview: readPreview(result.stderr),
                    stream: "stderr",
                    tail: readTail(result.stderr)
                })
            );
        }
    }

}

function toInputSummary(input: JsonValue): string {
    const summary = (() => {
        if (Array.isArray(input)) {
            return input.map((value) => JSON.stringify(value) ?? "null").join(" ");
        }

        if (typeof input === "object" && input !== null) {
            return JSON.stringify(input) ?? "null";
        }

        return String(input);
    })();

    return summary;
}

function asCommandResult(error: unknown): CommandResult | undefined {
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
        return undefined;
    }

    const candidate = error as Record<string, unknown>;

    if (
        typeof candidate.stdout === "string" &&
        typeof candidate.stderr === "string" &&
        (typeof candidate.exitCode === "number" || candidate.exitCode === null)
    ) {
        return {
            details: readCommandDiagnostic(candidate.details),
            exitCode: candidate.exitCode as number | null,
            signal: typeof candidate.signal === "string" ? candidate.signal : undefined,
            stderr: candidate.stderr,
            stdout: candidate.stdout,
            timedOut: candidate.timedOut === true
        };
    }

    const details = readCommandDiagnostic(candidate.details);

    if (details === undefined || (typeof details.exitCode !== "number" && details.exitCode !== null)) {
        return undefined;
    }

    return {
        details,
        exitCode: details.exitCode ?? null,
        signal: details.signal,
        stderr: "",
        stdout: "",
        timedOut: candidate.timedOut === true
    };
}

function asBashToolResult(value: JsonValue): {
    exitCode?: number | null;
    stderr: string;
    stderrBytes: number;
    stdout: string;
    stdoutBytes: number;
    termSignal?: number;
    termination?: "exited" | "signaled" | "timeout";
} | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const result = value as Record<string, JsonValue>;
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
        return undefined;
    }

    const termination = result.termination;
    return {
        ...(typeof result.exitCode === "number" || result.exitCode === null ? { exitCode: result.exitCode } : {}),
        stderr: result.stderr,
        stderrBytes: typeof result.stderrBytes === "number" ? result.stderrBytes : readByteLength(result.stderr),
        stdout: result.stdout,
        stdoutBytes: typeof result.stdoutBytes === "number" ? result.stdoutBytes : readByteLength(result.stdout),
        ...(typeof result.termSignal === "number" ? { termSignal: result.termSignal } : {}),
        ...(termination === "exited" || termination === "signaled" || termination === "timeout" ? { termination } : {})
    };
}

function readNonRunningSchedulerStatus(errorCode: string): "queueTimeout" | "cancelled" | undefined {
    if (errorCode === errorCodes.coreToolQueueTimeout) {
        return "queueTimeout";
    }

    if (errorCode === errorCodes.coreToolCallCancelled || errorCode === "tool.cancelled") {
        return "cancelled";
    }

    return undefined;
}

function normalizeToolSchedulerError(error: unknown): unknown {
    const errorCode = getErrorCode(error, errorCodes.coreProviderFailed);

    if (
        errorCode !== errorCodes.coreToolSchedulerFull &&
        errorCode !== errorCodes.coreToolQueueTimeout &&
        errorCode !== errorCodes.coreToolCallCancelled &&
        errorCode !== "tool.cancelled"
    ) {
        return error;
    }

    return createError({
        code: errorCode === "tool.cancelled" ? errorCodes.coreToolCallCancelled : errorCode,
        cause: error,
        message: error instanceof Error ? error.message : "Tool scheduler rejected the tool call.",
        retryable: true,
        details: readErrorDetails(error)
    });
}

function readErrorDetails(error: unknown): JsonValue {
    if (typeof error !== "object" || error === null || Array.isArray(error) || !("details" in error)) {
        return {};
    }

    const details = (error as { details?: unknown }).details;
    return details === undefined ? {} : (details as JsonValue);
}

function readByteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function readPreview(value: string): string {
    return value.slice(0, 160);
}

function readTail(value: string): string {
    return value.slice(-160);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) {
        return;
    }
    throw createError({
        code: errorCodes.coreToolCallCancelled,
        cause: signal.reason,
        message: "Tool call was cancelled by the client.",
        retryable: true,
        details: {
            reason: typeof signal.reason === "string" ? signal.reason : "client cancelled"
        }
    });
}
