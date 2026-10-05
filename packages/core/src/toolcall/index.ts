import { ToolCallHookRegistry } from "./registration/index.js";
import type { ToolCallHooks } from "./registration/Api.js";
import type { ToolCallApi } from "./execution/Api.js";
import { ToolCallPipeline, type ToolCallTarget, type ToolCallTargetResolver } from "./execution/Pipeline.js";
import type {
    InstanceName,
    JsonValue,
    ToolCallContext,
    ToolCallQuery,
    ToolCallRecord,
    ToolDefinition,
} from "@portable-devshell/shared";
import type { Endpoint } from "@portable-devshell/shared";
import type {
    AuditApi,
    AuditToolCallFailureSummary,
    InstanceLogEntry,
    LogQuery,
} from "../audit/Public.js";
import { WorkerInstanceTool } from "./execution/Tool.js";
import type { ToolCallRecordEventType } from "./execution/record/Event.js";
import { ToolCallHistory } from "./execution/record/History.js";
import { WorkerToolCallScheduler } from "./execution/Scheduler.js";
import { WorkerToolCatalog } from "./worker/Catalog.js";
import { WorkerToolInvoker } from "./worker/Invoker.js";

export interface ToolCallRuntime {
    readonly api: ToolCallApi;
    readonly hooks: ToolCallHooks;
    close(): void;
}

export function createToolCallRuntime(options: {
    resolveTarget: ToolCallTargetResolver;
}): ToolCallRuntime {
    const hooks = new ToolCallHookRegistry();
    return {
        api: new ToolCallPipeline({
            hooks: hooks.provider(),
            resolveExecute: (toolName) => hooks.lookupExecute(toolName),
            resolveTarget: options.resolveTarget,
        }),
        hooks,
        close: () => hooks.close(),
    };
}

export interface ToolCallExecutionRuntimeOptions {
    appendEvent(
        type: ToolCallRecordEventType,
        data?: JsonValue,
    ): Promise<unknown>;
    assertReady(): void;
    audit: AuditApi;
    endpoint: Endpoint;
    instanceName: InstanceName;
    readTools(): Promise<readonly ToolDefinition[]>;
}

export interface ToolCallExecutionRuntime {
    target(): ToolCallTarget;
    listTools(): ToolDefinition[];
    readToolCalls(query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    readLogs(query?: LogQuery): Promise<InstanceLogEntry[]>;
    hasActiveToolCalls(ctxId: string, excludeCallId?: string): boolean;
    readToolCallFailureSummary(
        sinceMs: number,
        untilMs: number,
    ): Promise<AuditToolCallFailureSummary>;
    invokeInternal(
        toolName: string,
        input: JsonValue,
        context?: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    refreshTools(): Promise<ToolDefinition[]>;
    close(): Promise<void>;
}

export function createToolCallExecutionRuntime(
    options: ToolCallExecutionRuntimeOptions,
): ToolCallExecutionRuntime {
    const catalog = new WorkerToolCatalog();
    const invoker = new WorkerToolInvoker(
        options.endpoint,
        `${options.instanceName}-worker`,
        catalog,
    );
    const scheduler = new WorkerToolCallScheduler();
    const tool = new WorkerInstanceTool({
        appendEvent: options.appendEvent,
        assertReady: options.assertReady,
        instanceName: options.instanceName,
        logStore: options.audit.logs,
        toolCallHistory: new ToolCallHistory(
            options.instanceName,
            options.audit.toolCalls,
        ),
        toolCallScheduler: scheduler,
        toolInvoker: invoker,
    });
    let closed = false;
    let closePromise: Promise<void> | undefined;
    return {
        target: () => tool.target(),
        listTools: () => catalog.listTools(),
        readToolCalls: (query) => tool.readToolCalls(query),
        readLogs: (query) => tool.readLogs(query),
        hasActiveToolCalls: (ctxId, excludeCallId) =>
            tool.hasActiveToolCalls(ctxId, excludeCallId),
        readToolCallFailureSummary: (sinceMs, untilMs) =>
            tool.readToolCallFailureSummary(sinceMs, untilMs),
        invokeInternal: (toolName, input, context, signal) =>
            tool.invokeInternal(toolName, input, context, signal),
        refreshTools: async () => {
            if (closed)
                throw new Error("Tool call execution runtime is closed.");
            const tools = await options.readTools();
            if (closed)
                throw new Error("Tool call execution runtime is closed.");
            return catalog.refresh(tools);
        },
        close: async () => {
            if (closePromise !== undefined) return await closePromise;
            closed = true;
            closePromise = (async () => {
                await scheduler.close();
                catalog.clear();
            })();
            await closePromise;
        },
    };
}
