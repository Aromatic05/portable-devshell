import { contextErrorCodes, createRemoteError, type ToolCallHooks } from "@portable-devshell/shared";

/** The Workspace open tool enters the Instance review, execute and audit pipeline. */
export function installMcpAppOpen(hooks: ToolCallHooks): () => void {
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
    return open;
}
