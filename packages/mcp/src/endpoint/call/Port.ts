import type { ToolCallApi } from "@portable-devshell/shared";

/** The single global tool-call ingress supplied by Control. */
export type ToolCallIngressPort = ToolCallApi;

export interface McpEndpointWorkerPort {
    snapshot(): { ready?: boolean };
    appendMcpToolCalled(
        toolName: string,
        context: { requestId?: string; ctxId?: string },
    ): Promise<void>;
}

export interface McpEndpointCallContext {
    principal: string;
    requestMeta?: Record<string, unknown>;
    requestId?: string;
}
