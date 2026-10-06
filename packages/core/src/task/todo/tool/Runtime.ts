import type { ToolCallHooks } from "../../../toolcall/Api.js";
import {
    contextErrorCodes,
    createRemoteError,
    type JsonValue,
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
            const result = await task.todo.read(readTodoToolInput(input));
            signal?.throwIfAborted();
            return result as unknown as JsonValue;
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
            return written as unknown as JsonValue;
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
