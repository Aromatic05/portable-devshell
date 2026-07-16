import {
    type ApprovalDecision,
    type ApprovalRequest,
    type InstanceName,
    type JsonValue,
    type ToolCallAssociation,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallRecord
} from "@portable-devshell/shared";

import type { ApprovalManager } from "../../approval/ApprovalManager.js";
import type { InstanceEventInput } from "../../instance/event/InstanceEventBuffer.js";
import type { LogQuery } from "../../log/LogQuery.js";
import type { InstanceLogEntry, LogStoreInstance } from "../../log/store/LogStoreInstance.js";
import type { AuditToolCallHistory } from "../../audit/tool/AuditToolCallHistory.js";
import type { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import type { WorkerToolCallScheduler } from "../tool/WorkerToolCallScheduler.js";
import { WorkerInstanceToolApproval } from "./tool/WorkerInstanceToolApproval.js";
import { WorkerInstanceToolAudit } from "./tool/WorkerInstanceToolAudit.js";
import { WorkerInstanceToolExecution } from "./tool/WorkerInstanceToolExecution.js";
import { WorkerInstanceToolLog } from "./tool/WorkerInstanceToolLog.js";

interface WorkerToolOptions {
    approvalManager: ApprovalManager;
    appendEvent(type: InstanceEventInput["type"], data?: JsonValue): Promise<unknown>;
    assertReady(): void;
    instanceName: InstanceName;
    logStore: LogStoreInstance;
    toolCallAssociationProvider?: () => ToolCallAssociation | undefined;
    toolCallHistory: AuditToolCallHistory;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstanceTool {
    readonly #approval: WorkerInstanceToolApproval;
    readonly #audit: WorkerInstanceToolAudit;
    readonly #execution: WorkerInstanceToolExecution;
    readonly #log: WorkerInstanceToolLog;

    constructor(options: WorkerToolOptions) {
        this.#approval = new WorkerInstanceToolApproval({
            approvalManager: options.approvalManager,
            appendEvent: options.appendEvent,
            toolCallHistory: options.toolCallHistory
        });
        this.#audit = new WorkerInstanceToolAudit({
            appendEvent: options.appendEvent,
            toolCallAssociationProvider: options.toolCallAssociationProvider,
            toolCallHistory: options.toolCallHistory
        });
        this.#log = new WorkerInstanceToolLog({
            appendEvent: options.appendEvent,
            logStore: options.logStore
        });
        this.#execution = new WorkerInstanceToolExecution({
            approval: this.#approval,
            assertReady: options.assertReady,
            audit: this.#audit,
            instanceName: options.instanceName,
            log: this.#log,
            toolCallScheduler: options.toolCallScheduler,
            toolInvoker: options.toolInvoker
        });
    }

    async call(toolName: string, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        return await this.#execution.call(toolName, input, context, signal);
    }

    async auditToolCall<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: () => Promise<T>,
        signal?: AbortSignal
    ): Promise<T> {
        return await this.#audit.auditOperation(toolName, input, context, operation, signal);
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
        return await this.#log.read(query);
    }

    async readToolCalls(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#audit.read(query);
    }
}
