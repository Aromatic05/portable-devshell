import type { ToolCallHooks } from "../../../toolcall/Runtime.js";
import {
    mcpAllInstances,
    mcpTools,
} from "@portable-devshell/mcp/tool";
import {
    contextErrorCodes,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
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
