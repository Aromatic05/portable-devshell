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
        onExecutionActivity: options.onExecutionActivity,
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
    let sessionTail = Promise.resolve();
    const serializeSession = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = sessionTail.then(operation);
        sessionTail = result.then(() => undefined, () => undefined);
        return result;
    };
    const releaseSession = async (connectionId: string): Promise<void> => {
        const workspace = sessions.get(connectionId);
        if (workspace === undefined) return;
        if (![...sessions].some(([id, value]) => id !== connectionId && value === workspace))
            await options.releaseWorkspace(workspace);
        // Failed release keeps the owner and Workspace available for retry.
        sessions.delete(connectionId);
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
        openSession: (workspace, connectionId) => serializeSession(async () => {
            if (closed)
                throw new Error("Tool call execution runtime is closed.");
            await releaseSession(connectionId);
            const prepared = await options.prepareWorkspace(workspace);
            sessions.set(connectionId, prepared.workspace);
            await refreshTools();
            return prepared;
        }),
        releaseSession: (connectionId) => serializeSession(() => releaseSession(connectionId)),
        refreshTools,
        close: async () => {
            if (closePromise !== undefined) return await closePromise;
            closed = true;
            closePromise = (async () => {
                const failures: unknown[] = [];
                await scheduler.close().catch((error) => failures.push(error));
                for (const connectionId of [...sessions.keys()])
                    await serializeSession(() => releaseSession(connectionId)).catch((error) =>
                        failures.push(error),
                    );
                catalog.clear();
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1)
                    throw new AggregateError(
                        failures,
                        "Tool call execution runtime failed to close cleanly.",
                    );
            })().catch((error: unknown) => {
                closePromise = undefined;
                throw error;
            });
            await closePromise;
        },
    };
}
