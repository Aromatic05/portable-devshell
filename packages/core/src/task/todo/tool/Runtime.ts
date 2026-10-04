import type { ToolCallHooks } from "../../../tool/Runtime.js";
import {
    mcpAllInstances,
    mcpTools,
} from "@portable-devshell/mcp/tool";
import {
    contextErrorCodes,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type TodoReadResult,
    type TodoWriteInput,
} from "@portable-devshell/shared";

import type { TaskApi } from "../../Api.js";
import { todoToolDefinitions } from "./Definition.js";
import { readTodoToolInput } from "./Input.js";

export function installTodoTools(
    hooks: ToolCallHooks,
    resolveTask: (instance: string) => TaskApi | undefined,
): () => void {
    const definitions = mcpTools.register(mcpAllInstances, todoToolDefinitions());
    const unregisterRead = hooks.registerExecute(
        "todo_read",
        async (_callId, input, value, signal) => {
            signal?.throwIfAborted();
            const result = await requireTask(
                value.context.instance,
                resolveTask,
            ).todo.read(readTodoToolInput(input));
            signal?.throwIfAborted();
            return result as unknown as JsonValue;
        },
    );
    const unregisterWrite = hooks.registerExecute(
        "todo_write",
        async (_callId, input, value, signal) => {
            signal?.throwIfAborted();
            const task = requireTask(value.context.instance, resolveTask);
            const ctxId = requireCtxId(value.context.ctxId);
            const written = await task.todo.write(
                input as unknown as TodoWriteInput,
                ctxId,
            );
            signal?.throwIfAborted();
            const terminalTaskId = terminalTodoTaskId(written);
            if (terminalTaskId !== undefined)
                await disableTaskWaitRecoveries(task, terminalTaskId);
            return written as unknown as JsonValue;
        },
    );
    return () => {
        unregisterWrite();
        unregisterRead();
        definitions.dispose();
    };
}

function requireTask(
    instance: string,
    resolveTask: (instance: string) => TaskApi | undefined,
): TaskApi {
    const task = resolveTask(instance);
    if (task !== undefined) return task;
    throw createRemoteError({
        code: runtimeErrorCodes.instanceNotReady,
        details: { instance },
        message: `Instance ${instance} task runtime is unavailable.`,
        retryable: false,
    });
}

function requireCtxId(ctxId: string | undefined): string {
    if (ctxId !== undefined && ctxId.length > 0) return ctxId;
    throw createRemoteError({
        code: contextErrorCodes.invalid,
        message: "todo_write requires a validated ctxId.",
        retryable: false,
    });
}

async function disableTaskWaitRecoveries(
    task: TaskApi,
    taskId: string,
): Promise<void> {
    const wait = task.wait;
    if (wait === undefined) return;
    for (const record of await wait.list(taskId)) {
        if (
            record.status === "consumed" ||
            record.status === "cancelled"
        )
            continue;
        if (
            record.kind === "question" &&
            (record.status === "waiting" || record.status === "detached")
        ) {
            await wait.cancel(record.waitId).catch(() => undefined);
            continue;
        }
        await wait.disableRecovery(record.waitId).catch(() => undefined);
    }
}

function terminalTodoTaskId(result: TodoReadResult): string | undefined {
    if (typeof result.taskId !== "string") return undefined;
    if (typeof result.cancelledAt === "string") return result.taskId;
    if (result.items.length === 0) return undefined;
    const active = result.items.some(
        (item) =>
            item.status === "pending" ||
            item.status === "in_progress" ||
            item.status === "blocked",
    );
    return active ? undefined : result.taskId;
}
