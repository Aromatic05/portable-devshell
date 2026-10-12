import { contextErrorCodes, createRemoteError, type JsonValue, type ToolCallHooks } from "@portable-devshell/shared";

/** Both presentation tools still enter Instance review, execute and audit. */
export function installMcpAppAsk(hooks: ToolCallHooks): () => void {
    const context = (value: { context: { source: string; ctxId?: string } }) => {
        const ctxId = value.context.ctxId;
        if (value.context.source !== "mcp" || !ctxId)
            throw createRemoteError({ code: contextErrorCodes.invalid,
                message: "An authenticated MCP Context is required.", retryable: false });
        return ctxId;
    };
    const open = hooks.registerExecute("mcpapp_open", async (_callId, _input, value, signal) => {
        signal?.throwIfAborted();
        return { status: "ready", ctxId: context(value) };
    });
    const ask = hooks.registerExecute("mcpapp_ask", async (_callId, input, value, signal) => {
        signal?.throwIfAborted();
        context(value);
        if (input === null || typeof input !== "object" || Array.isArray(input))
            throw new Error("Invalid user question.");
        const { question, choices, allowText } = input;
        if (typeof question !== "string" || question.trim().length === 0 || question.length > 4000 ||
            (allowText !== undefined && typeof allowText !== "boolean") ||
            (choices !== undefined && (!Array.isArray(choices) || choices.length > 12 ||
                !choices.every((option) => typeof option === "string" && option.length > 0 && option.length <= 256))) ||
            (allowText === false && (!Array.isArray(choices) || choices.length === 0)))
            throw new Error("Invalid user question options.");
        return { status: "ready", question: question.trim(),
            choices: (choices ?? []) as JsonValue, allowText: allowText !== false } as JsonValue;
    });
    return () => { ask(); open(); };
}
