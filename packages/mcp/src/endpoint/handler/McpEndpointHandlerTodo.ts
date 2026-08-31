import type { JsonValue, TodoReadInput, ToolCallContext } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogTodoName } from "../../tool/catalog/McpToolCatalogTodo.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerTodo {
    constructor(private readonly options: {
        gateway?: McpInstanceGateway;
        instanceName: string;
    }) {}

    async call(toolName: McpToolCatalogTodoName, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
            case "todo_read":
                return await waitForMcpEndpointAbortable(
                    gateway.readTodo(this.options.instanceName, readTodoInput(input)),
                    signal
                );
            case "todo_write": {
                const written = await waitForMcpEndpointAbortable(
                    gateway.writeTodo(this.options.instanceName, input, context),
                    signal
                );
                const terminalTaskId = terminalTodoTaskId(written);
                if (terminalTaskId !== undefined) {
                    await disableTaskWaitRecoveries(gateway, this.options.instanceName, terminalTaskId);
                }
                return written;
            }
        }
    }
}

async function disableTaskWaitRecoveries(
    gateway: McpInstanceGateway,
    instance: string,
    taskId: string,
): Promise<void> {
    if (gateway.listWaits === undefined || gateway.disableWaitRecovery === undefined) return;
    const waits = await gateway.listWaits(instance);
    for (const wait of waits) {
        if (wait.taskId !== taskId || wait.status === "consumed" || wait.status === "cancelled") continue;
        if (wait.kind === "question" && (wait.status === "waiting" || wait.status === "detached") && gateway.cancelWait !== undefined) {
            await gateway.cancelWait(instance, wait.waitId).catch(() => undefined);
            continue;
        }
        await gateway.disableWaitRecovery(instance, wait.waitId).catch(() => undefined);
    }
}

function terminalTodoTaskId(result: JsonValue): string | undefined {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
    const taskId = result.taskId;
    if (typeof taskId !== "string") return undefined;
    if (typeof result.cancelledAt === "string") return taskId;
    if (!Array.isArray(result.items) || result.items.length === 0) return undefined;
    const active = result.items.some((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
        return item.status === "pending" || item.status === "in_progress" || item.status === "blocked";
    });
    return active ? undefined : taskId;
}

function readTodoInput(input: JsonValue): TodoReadInput | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("todo_read requires an object input.");
    }
    const keys = Object.keys(input);
    if (keys.length === 0) return undefined;
    if (keys.length !== 1 || (keys[0] !== "taskId" && keys[0] !== "title")) {
        throw new Error("todo_read accepts only one optional selector: taskId or title.");
    }
    const key = keys[0] as "taskId" | "title";
    const value = input[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`todo_read ${key} must be a non-empty string.`);
    }
    return { [key]: value.trim() };
}
