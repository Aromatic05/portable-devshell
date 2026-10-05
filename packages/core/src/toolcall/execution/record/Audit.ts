import type { ToolCallRecordEventType } from "./Event.js";
import {
    runtimeErrorCodes,
    type CommandResult,
    type JsonValue,
    type ToolCallContext,
    type ToolCallFailureStage,
    type ToolCallQuery,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import type { ToolCallHistory } from "./History.js";
import { getErrorCode } from "../Error.js";
import { toEventData } from "./Event.js";
import {
    createToolCallScope,
    type ToolCallScope,
} from "../Context.js";
import type { WorkerInstanceBashToolResult } from "./Result.js";
import {
    commandResultOutput,
    readByteLength,
    stripCommandStreams,
} from "./Result.js";

interface WorkerInstanceToolAuditOptions {
    appendEvent(
        type: ToolCallRecordEventType,
        data?: JsonValue,
    ): Promise<unknown>;
    toolCallHistory: ToolCallHistory;
}

export type ToolCallRunningContext = ToolCallScope["eventContext"];

export class WorkerInstanceToolAudit {
    readonly #appendEvent: WorkerInstanceToolAuditOptions["appendEvent"];
    readonly #toolCallHistory: ToolCallHistory;

    constructor(options: WorkerInstanceToolAuditOptions) {
        this.#appendEvent = options.appendEvent;
        this.#toolCallHistory = options.toolCallHistory;
    }

    createScope(
        callId: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
    ): ToolCallScope {
        return createToolCallScope(callId, toolName, input, context);
    }

    runningContext(scope: ToolCallScope): ToolCallRunningContext {
        return scope.eventContext;
    }

    async requested(scope: ToolCallScope): Promise<void> {
        await this.#toolCallHistory.started(
            scope.callId,
            scope.toolName,
            scope.inputSummary,
            scope.context,
            scope.startedAt,
            "queued",
            scope.input,
        );
    }

    async queued(scope: ToolCallScope): Promise<void> {
        if (!this.#toolCallHistory.hasActive(scope.callId))
            await this.requested(scope);
        await this.#appendEvent(
            "toolCall.queued",
            toEventData({
                ...scope.eventContext,
                queuedAt: scope.startedAt,
                startedAt: scope.startedAt,
                status: "queued",
            }),
        );
    }

    async running(
        scope: ToolCallScope,
        runningContext: ToolCallRunningContext,
    ): Promise<void> {
        await this.#toolCallHistory.running(scope.callId);
        await this.#appendEvent(
            "toolCall.running",
            toEventData({
                ...runningContext,
                startedAt: scope.startedAt,
                status: "running",
            }),
        );
    }

    async completed(
        scope: ToolCallScope,
        runningContext: ToolCallRunningContext,
        result: JsonValue,
        bashResult: WorkerInstanceBashToolResult | undefined,
        appendLogs: () => Promise<void>,
    ): Promise<void> {
        const completedAt = new Date().toISOString();
        await this.#toolCallHistory.completed(scope.callId, completedAt, {
            output:
                bashResult === undefined ? result : stripCommandStreams(result),
            ...(bashResult === undefined
                ? {}
                : {
                      exitCode: bashResult.exitCode,
                      stderrBytes: bashResult.stderrBytes,
                      stdoutBytes: bashResult.stdoutBytes,
                      termSignal: bashResult.termSignal,
                      termination: bashResult.termination,
                  }),
        });
        await appendLogs();
        await this.#appendEvent(
            "toolCall.completed",
            toEventData({
                ...runningContext,
                completedAt,
                exitCode: bashResult?.exitCode,
                startedAt: scope.startedAt,
                status: "completed",
                stderrBytes: bashResult?.stderrBytes,
                stdoutBytes: bashResult?.stdoutBytes,
                termSignal: bashResult?.termSignal,
                termination: bashResult?.termination,
            }),
        );
    }

    async nonRunning(
        scope: ToolCallScope,
        runningContext: ToolCallRunningContext,
        status: "queueTimeout" | "cancelled",
        errorCode: string,
    ): Promise<void> {
        const completedAt = new Date().toISOString();
        if (status === "queueTimeout") {
            await this.#toolCallHistory.queueTimeout(
                scope.callId,
                errorCode,
                completedAt,
            );
        } else {
            await this.#toolCallHistory.cancelled(
                scope.callId,
                errorCode,
                completedAt,
            );
        }
        await this.#appendEvent(
            status === "queueTimeout"
                ? "toolCall.queueTimeout"
                : "toolCall.cancelled",
            toEventData({
                ...runningContext,
                completedAt,
                errorCode,
                startedAt: scope.startedAt,
                status,
            }),
        );
    }

    async failed(
        scope: ToolCallScope,
        runningContext: ToolCallRunningContext,
        errorCode: string,
        result: CommandResult | undefined,
        appendLogs: () => Promise<void>,
        failure?: {
            executionCompleted?: boolean;
            failureStage?: ToolCallFailureStage;
        },
    ): Promise<void> {
        const completedAt = new Date().toISOString();
        await appendLogs();
        const completion =
            result === undefined && failure === undefined
                ? undefined
                : {
                      ...(failure ?? {}),
                      ...(result === undefined
                          ? {}
                          : {
                                exitCode: result.exitCode,
                                output: stripCommandStreams(
                                    commandResultOutput(result),
                                ),
                                stderrBytes: readByteLength(result.stderr),
                                stdoutBytes: readByteLength(result.stdout),
                            }),
                  };
        await this.#toolCallHistory.failed(
            scope.callId,
            errorCode,
            completedAt,
            completion,
        );
        await this.#appendEvent(
            "toolCall.failed",
            toEventData({
                ...runningContext,
                completedAt,
                errorCode,
                executionCompleted: failure?.executionCompleted,
                exitCode: result?.exitCode,
                failureStage: failure?.failureStage,
                startedAt: scope.startedAt,
                status: "failed",
                stderrBytes:
                    result === undefined
                        ? undefined
                        : readByteLength(result.stderr),
                stdoutBytes:
                    result === undefined
                        ? undefined
                        : readByteLength(result.stdout),
            }),
        );
    }

    async failActive(scope: ToolCallScope, error: unknown): Promise<void> {
        if (!this.#toolCallHistory.hasActive(scope.callId)) {
            return;
        }

        await this.#toolCallHistory
            .failed(
                scope.callId,
                getErrorCode(error, runtimeErrorCodes.providerFailed),
                new Date().toISOString(),
            )
            .catch(() => undefined);
    }

    async read(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#toolCallHistory.read(query);
    }

    hasActiveForContext(ctxId: string, excludeCallId?: string): boolean {
        return this.#toolCallHistory.hasActiveForContext(ctxId, excludeCallId);
    }

    async readFailureSummary(sinceMs: number, untilMs: number) {
        return await this.#toolCallHistory.readFailureSummary(sinceMs, untilMs);
    }
}
