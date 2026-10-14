import {
    contextErrorCodes,
    createRemoteError,
    type JsonValue,
    type ToolCallHooks,
    type TodoWriteInput,
} from "@portable-devshell/shared";

import type { TaskApi } from "../../Api.js";
import { readTodoToolInput } from "./Input.js";

export function installTodoTools(
    hooks: ToolCallHooks,
    task: TaskApi,
): () => void {
    const unregisterRead = hooks.registerExecute(
        "todo_read",
        async (_callId, input, value, signal) => {
            signal?.throwIfAborted();
            const selector = readTodoToolInput(input);
            const result = await task.todo.read(selector?.taskId === undefined
                ? undefined : { taskId: selector.taskId });
            signal?.throwIfAborted();
            const offset = selector?.offset ?? 0;
            const limit = selector?.limit ?? 20;
            const items = result.tasks ?? result.items;
            if (items.length <= limit && offset === 0) return result as unknown as JsonValue;
            const page = items.slice(offset, offset + limit);
            return {
                ...result,
                [result.tasks === undefined ? "items" : "tasks"]: page,
                offset,
                ...(offset + page.length >= items.length ? {}
                    : { nextOffset: offset + page.length }),
            } as unknown as JsonValue;
        },
    );
    const unregisterWrite = hooks.registerExecute(
        "todo_write",
        async (_callId, input, value, signal) => {
            signal?.throwIfAborted();
            const ctxId = requireCtxId(value.context.ctxId);
            const written = await task.todo.write(
                input as unknown as TodoWriteInput,
                ctxId,
            );
            signal?.throwIfAborted();
            // Writing a complete plan does not require echoing every item.
            // The authoritative state remains available through todo_read.
            return {
                ...(written.checkpoint === undefined ? {} : { checkpoint: written.checkpoint }),
                revision: written.revision,
                summary: written.summary,
                ...(written.taskId === undefined ? {} : { taskId: written.taskId }),
                ...(written.title === undefined ? {} : { title: written.title }),
            } as unknown as JsonValue;
        },
    );
    return () => {
        unregisterWrite();
        unregisterRead();
    };
}

function requireCtxId(ctxId: string | undefined): string {
    if (ctxId !== undefined && ctxId.length > 0) return ctxId;
    throw createRemoteError({
        code: contextErrorCodes.invalid,
        message: "todo_write requires a validated ctxId.",
        retryable: false,
    });
}
