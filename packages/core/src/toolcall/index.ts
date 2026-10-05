import { ToolCallHookRegistry } from "./registration/index.js";

import type { ToolCallExecutionRuntime, ToolCallExecutionRuntimeOptions, ToolCallProvenanceApi, ToolCallProvenanceOptions, ToolCallRuntime, ToolCallTargetResolver, ToolNameRegistrar } from "./Api.js";
import { ToolCallPipeline } from "./execution/Pipeline.js";


import { WorkerInstanceTool } from "./execution/Tool.js";

import { ToolCallHistory } from "./execution/record/History.js";
import { WorkerToolCallScheduler } from "./execution/Scheduler.js";
import { WorkerToolCatalog } from "./worker/Catalog.js";
import { WorkerToolInvoker } from "./worker/Invoker.js";
import { ToolCallProvenanceStore } from "./execution/record/Provenance.js";

export function createToolCallRuntime(options: {
    registerToolName?: ToolNameRegistrar;
    resolveTarget: ToolCallTargetResolver;
}): ToolCallRuntime {
    const hooks = new ToolCallHookRegistry(options.registerToolName);
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

export function createToolCallProvenanceRuntime(
    filePath: string,
    options: ToolCallProvenanceOptions = {},
): ToolCallProvenanceApi {
    return new ToolCallProvenanceStore(filePath, options);
}
