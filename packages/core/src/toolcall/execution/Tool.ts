import type { ToolCallRecordEventType } from "./record/Event.js";
import {
    type InstanceName,
    type JsonValue,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import type { LogQuery } from "../../audit/Public.js";
import type {
    InstanceLogEntry,
    AuditLogs,
} from "../../audit/Public.js";
import type { ToolCallHistory } from "./record/History.js";
import type { WorkerToolInvoker } from "../worker/Invoker.js";
import type { WorkerToolCallScheduler } from "./Scheduler.js";
import { WorkerInstanceToolAudit } from "./record/Audit.js";
import { ToolCallExecutionTarget } from "./ExecutionTarget.js";
import type { ToolCallTarget } from "./Pipeline.js";
import { WorkerInstanceToolLog } from "./record/Log.js";

export interface WorkerToolOptions {
    appendEvent(
        type: ToolCallRecordEventType,
        data?: JsonValue,
    ): Promise<unknown>;
    assertReady(): void;
    instanceName: InstanceName;
    logStore: AuditLogs;
    toolCallHistory: ToolCallHistory;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: Pick<WorkerToolInvoker, "invoke">;
}

export class WorkerInstanceTool {
    readonly #audit: WorkerInstanceToolAudit;
    readonly #target: ToolCallExecutionTarget;
    readonly #log: WorkerInstanceToolLog;
    readonly #toolInvoker: Pick<WorkerToolInvoker, "invoke">;

    constructor(options: WorkerToolOptions) {
        this.#audit = new WorkerInstanceToolAudit({
            appendEvent: options.appendEvent,
            toolCallHistory: options.toolCallHistory,
        });
        this.#toolInvoker = options.toolInvoker;
        this.#log = new WorkerInstanceToolLog({
            appendEvent: options.appendEvent,
            logStore: options.logStore,
        });
        this.#target = new ToolCallExecutionTarget({
            assertReady: options.assertReady,
            audit: this.#audit,
            instanceName: options.instanceName,
            log: this.#log,
            toolCallScheduler: options.toolCallScheduler,
            toolInvoker: options.toolInvoker,
        });
    }

    target(): ToolCallTarget {
        return this.#target;
    }

    async invokeInternal(
        toolName: string,
        input: JsonValue,
        context?: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        return await this.#toolInvoker.invoke(
            toolName,
            input,
            context,
            signal,
        );
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
