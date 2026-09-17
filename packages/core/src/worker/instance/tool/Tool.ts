import {
    type ApprovalDecision,
    type ApprovalRequest,
    type InstanceName,
    type JsonValue,
    type ToolCallAssociation,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import type { ApprovalManager } from "../../../approval/Manager.js";
import type { InstanceEventInput } from "../../../instance/EventBuffer.js";
import type { LogQuery } from "../../../storage/log/Query.js";
import type {
    InstanceLogEntry,
    LogStoreInstance,
} from "../../../storage/log/Store.js";
import type { AuditToolCallHistory } from "../../../storage/audit/ToolCallHistory.js";
import type { WorkerToolInvoker } from "../../tool/Invoker.js";
import type { WorkerToolCallScheduler } from "../../tool/Scheduler.js";
import { ToolCallApproval } from "../../../toolcall/Approval.js";
import { WorkerInstanceToolAudit } from "./record/Audit.js";
import { ToolCallExecution } from "../../../toolcall/Execution.js";
import type { ToolCallBoundaryProvider } from "../../../toolcall/boundary/Sequence.js";
import { WorkerInstanceToolLog } from "./record/Log.js";

interface WorkerToolOptions {
    approvalManager: ApprovalManager;
    appendEvent(
        type: InstanceEventInput["type"],
        data?: JsonValue,
    ): Promise<unknown>;
    assertReady(): void;
    instanceName: InstanceName;
    logStore: LogStoreInstance;
    toolCallAssociationProvider?: (
        context: ToolCallContext,
    ) => ToolCallAssociation | undefined;
    toolCallHistory: AuditToolCallHistory;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstanceTool {
    readonly #approval: ToolCallApproval;
    readonly #audit: WorkerInstanceToolAudit;
    readonly #execution: ToolCallExecution;
    readonly #log: WorkerInstanceToolLog;

    constructor(options: WorkerToolOptions) {
        this.#approval = new ToolCallApproval({
            approvalManager: options.approvalManager,
            appendEvent: options.appendEvent,
            toolCallHistory: options.toolCallHistory,
        });
        this.#audit = new WorkerInstanceToolAudit({
            appendEvent: options.appendEvent,
            toolCallAssociationProvider: options.toolCallAssociationProvider,
            toolCallHistory: options.toolCallHistory,
        });
        this.#log = new WorkerInstanceToolLog({
            appendEvent: options.appendEvent,
            logStore: options.logStore,
        });
        this.#execution = new ToolCallExecution({
            approval: this.#approval,
            assertReady: options.assertReady,
            audit: this.#audit,
            instanceName: options.instanceName,
            log: this.#log,
            toolCallScheduler: options.toolCallScheduler,
            toolInvoker: options.toolInvoker,
        });
    }

    bindBoundary(boundary: ToolCallBoundaryProvider): void {
        this.#execution.bindBoundary(boundary);
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
        invocationInput?: JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording: "caller" | "host" = "host",
    ): Promise<JsonValue> {
        return await this.#execution.call(
            toolName,
            input,
            context,
            signal,
            transformResult,
            invocationInput,
            onProgress,
            recording,
        );
    }

    async auditToolCall<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        return await this.#audit.auditOperation(
            toolName,
            input,
            context,
            operation,
            signal,
        );
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        return await this.#approval.listApprovals();
    }

    async listPendingApprovals(ctxId?: string): Promise<ApprovalRequest[]> {
        return await this.#approval.listPendingApprovals(ctxId);
    }

    async getApproval(approvalId: string): Promise<ApprovalRequest> {
        return await this.#approval.getApproval(approvalId);
    }

    async decideApproval(
        approvalId: string,
        input: {
            decision: ApprovalDecision["decision"];
            decidedBy: ApprovalDecision["decidedBy"];
            policyPatch?: JsonValue;
            reason?: string;
            remember?: boolean;
        },
    ): Promise<ApprovalRequest> {
        return await this.#approval.decideApproval(approvalId, input);
    }

    async cancelApproval(
        approvalId: string,
        reason?: string,
    ): Promise<ApprovalRequest> {
        return await this.#approval.cancelApproval(approvalId, reason);
    }

    async readLogs(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        return await this.#log.read(query);
    }

    async readToolCalls(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#audit.read(query);
    }

    hasActiveToolCalls(ctxId: string, excludeCallId?: string): boolean {
        return this.#audit.hasActiveForContext(ctxId, excludeCallId);
    }

    async readToolCallFailureSummary(sinceMs: number, untilMs: number) {
        return await this.#audit.readFailureSummary(sinceMs, untilMs);
    }
}
