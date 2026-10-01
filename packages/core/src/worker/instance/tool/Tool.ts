import {
    type ApprovalDecision,
    type ApprovalRequest,
    type InstanceName,
    type JsonValue,
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
import {
    ToolCallPipeline,
    type ToolCallTarget,
    type ToolCallTargetResolver,
} from "../../../toolcall/Pipeline.js";
import type { ToolCallHookProvider } from "../../../toolcall/hook/Sequence.js";
import type {
    ToolCallReviewInput,
    ToolCallReviewResult,
} from "../../../toolcall/hook/Review.js";
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
    toolCallHistory: AuditToolCallHistory;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstanceTool {
    readonly #approval: ToolCallApproval;
    readonly #audit: WorkerInstanceToolAudit;
    readonly #pipeline: ToolCallPipeline;
    readonly #log: WorkerInstanceToolLog;

    constructor(options: WorkerToolOptions) {
        this.#approval = new ToolCallApproval({
            approvalManager: options.approvalManager,
            appendEvent: options.appendEvent,
        });
        this.#audit = new WorkerInstanceToolAudit({
            appendEvent: options.appendEvent,
            toolCallHistory: options.toolCallHistory,
        });
        this.#log = new WorkerInstanceToolLog({
            appendEvent: options.appendEvent,
            logStore: options.logStore,
        });
        this.#pipeline = new ToolCallPipeline({
            assertReady: options.assertReady,
            audit: this.#audit,
            instanceName: options.instanceName,
            log: this.#log,
            toolCallScheduler: options.toolCallScheduler,
            toolInvoker: options.toolInvoker,
        });
    }

    bindHooks(boundary: ToolCallHookProvider): void {
        this.#pipeline.bindHooks(boundary);
    }

    bindTargetResolver(resolveTarget: ToolCallTargetResolver): void {
        this.#pipeline.bindTargetResolver(resolveTarget);
    }

    target(): ToolCallTarget {
        return this.#pipeline;
    }

    async reviewApproval(
        input: ToolCallReviewInput,
        signal: AbortSignal,
        recording: "caller" | "host",
    ): Promise<ToolCallReviewResult> {
        return await this.#approval.review(input, signal, recording);
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
        afterReview?: (
            callId: string,
            instance: InstanceName,
        ) => Promise<void> | void,
    ): Promise<JsonValue> {
        return await this.#pipeline.call(
            toolName,
            input,
            context,
            signal,
            transformResult,
            invocationInput,
            onProgress,
            recording,
            afterReview,
        );
    }

    async callOperation<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string, input: JsonValue) => Promise<T>,
        signal?: AbortSignal,
        afterReview?: (
            callId: string,
            instance: InstanceName,
        ) => Promise<void> | void,
    ): Promise<T> {
        return await this.#pipeline.callOperation(
            toolName,
            input,
            context,
            operation,
            signal,
            afterReview,
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
