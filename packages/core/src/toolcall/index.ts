import type { ToolCallExecutionRuntime, ToolCallExecutionRuntimeOptions } from "./Api.js";
import { WorkerInstanceTool } from "./execution/Tool.js";

import { ToolCallHistory } from "./execution/record/History.js";
import { WorkerToolCallScheduler } from "./execution/Scheduler.js";
import { WorkerToolCatalog } from "./worker/Catalog.js";
import { WorkerToolInvoker } from "./worker/Invoker.js";

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
    const sessions = new Map<string, string>();
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const releaseSession = async (connectionId: string): Promise<void> => {
        const workspace = sessions.get(connectionId);
        if (workspace === undefined) return;
        sessions.delete(connectionId);
        if ([...sessions.values()].includes(workspace)) return;
        await options.releaseWorkspace(workspace);
    };
    const refreshTools = async () => {
        if (closed)
            throw new Error("Tool call execution runtime is closed.");
        const tools = await options.readTools();
        if (closed)
            throw new Error("Tool call execution runtime is closed.");
        return catalog.refresh(tools);
    };
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
        openSession: async (workspace, connectionId) => {
            if (closed)
                throw new Error("Tool call execution runtime is closed.");
            await releaseSession(connectionId);
            const prepared = await options.prepareWorkspace(workspace);
            sessions.set(connectionId, prepared.workspace);
            await refreshTools();
            return prepared;
        },
        releaseSession,
        refreshTools,
        close: async () => {
            if (closePromise !== undefined) return await closePromise;
            closed = true;
            closePromise = (async () => {
                const failures: unknown[] = [];
                await scheduler.close().catch((error) => failures.push(error));
                for (const connectionId of [...sessions.keys()])
                    await releaseSession(connectionId).catch((error) =>
                        failures.push(error),
                    );
                catalog.clear();
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1)
                    throw new AggregateError(
                        failures,
                        "Tool call execution runtime failed to close cleanly.",
                    );
            })();
            await closePromise;
        },
    };
}
