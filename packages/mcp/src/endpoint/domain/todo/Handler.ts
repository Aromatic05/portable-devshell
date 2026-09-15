import {
    type JsonValue,
    type ToolCallContext,
} from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../Port.js";
import type { McpToolCatalogTodoName } from "./Catalog.js";
import { readTodoInput, readTodoReportMessage } from "./Input.js";
import { waitForMcpEndpointAbortable } from "../../dispatch/Support.js";
import { McpNativeToolResult, type McpEndpointResult } from "../../Endpoint.js";
import { requireMcpEndpointGateway } from "../../dispatch/Support.js";

export class McpEndpointHandlerTodo {
    constructor(
        private readonly options: {
            gateway?: McpInstanceGateway;
            instanceName: string;
        },
    ) {}

    async call(
        toolName: McpToolCatalogTodoName,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        callId?: string,
    ): Promise<McpEndpointResult> {
        const gateway = requireMcpEndpointGateway(
            this.options.gateway,
            this.options.instanceName,
        );
        switch (toolName) {
            case "todo_read":
                return await waitForMcpEndpointAbortable(
                    gateway.readTodo(
                        this.options.instanceName,
                        readTodoInput(input),
                    ),
                    signal,
                );
            case "todo_report": {
                const message = readTodoReportMessage(input);
                if (callId !== undefined && gateway.reportTodo !== undefined) {
                    await waitForMcpEndpointAbortable(
                        gateway.reportTodo(
                            this.options.instanceName,
                            message,
                            callId,
                            context,
                        ),
                        signal,
                    );
                }
                return new McpNativeToolResult({
                    content: [{ type: "text", text: message }],
                    structuredContent: { reported: true },
                });
            }
            case "todo_write": {
                const written = await waitForMcpEndpointAbortable(
                    gateway.writeTodo(
                        this.options.instanceName,
                        input,
                        context,
                    ),
                    signal,
                );
                const terminalTaskId = terminalTodoTaskId(written);
                if (terminalTaskId !== undefined) {
                    await disableTaskWaitRecoveries(
                        gateway,
                        this.options.instanceName,
                        terminalTaskId,
                    );
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
    if (
        gateway.listWaits === undefined ||
        gateway.disableWaitRecovery === undefined
    )
        return;
    const waits = await gateway.listWaits(instance);
    for (const wait of waits) {
        if (
            wait.taskId !== taskId ||
            wait.status === "consumed" ||
            wait.status === "cancelled"
        )
            continue;
        if (
            wait.kind === "question" &&
            (wait.status === "waiting" || wait.status === "detached") &&
            gateway.cancelWait !== undefined
        ) {
            await gateway
                .cancelWait(instance, wait.waitId)
                .catch(() => undefined);
            continue;
        }
        await gateway
            .disableWaitRecovery(instance, wait.waitId)
            .catch(() => undefined);
    }
}

function terminalTodoTaskId(result: JsonValue): string | undefined {
    if (typeof result !== "object" || result === null || Array.isArray(result))
        return undefined;
    const taskId = result.taskId;
    if (typeof taskId !== "string") return undefined;
    if (typeof result.cancelledAt === "string") return taskId;
    if (!Array.isArray(result.items) || result.items.length === 0)
        return undefined;
    const active = result.items.some((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item))
            return false;
        return (
            item.status === "pending" ||
            item.status === "in_progress" ||
            item.status === "blocked"
        );
    });
    return active ? undefined : taskId;
}
