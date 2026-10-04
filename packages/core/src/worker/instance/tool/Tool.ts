import {
    type InstanceName,
    type JsonValue,
    type ToolCallQuery,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import type { InstanceEventInput } from "../../../instance/EventBuffer.js";
import type { LogQuery } from "../../../storage/log/Query.js";
import type {
    InstanceLogEntry,
    LogStoreInstance,
} from "../../../storage/log/Store.js";
import type { AuditToolCallHistory } from "../../../storage/audit/ToolCallHistory.js";
import type { WorkerToolInvoker } from "../../tool/Invoker.js";
import type { WorkerToolCallScheduler } from "../../tool/Scheduler.js";
import { WorkerInstanceToolAudit } from "./record/Audit.js";
import { ToolCallExecutionTarget } from "./ExecutionTarget.js";
import type { ToolCallTarget } from "../../../tool/Pipeline.js";
import { WorkerInstanceToolLog } from "./record/Log.js";

interface WorkerToolOptions {
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
    readonly #audit: WorkerInstanceToolAudit;
    readonly #target: ToolCallExecutionTarget;
    readonly #log: WorkerInstanceToolLog;

    constructor(options: WorkerToolOptions) {
        this.#audit = new WorkerInstanceToolAudit({
            appendEvent: options.appendEvent,
            toolCallHistory: options.toolCallHistory,
        });
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
