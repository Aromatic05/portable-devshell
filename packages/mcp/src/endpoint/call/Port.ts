import type {
    JsonValue,
    ToolCallContext,
    ToolCallQuery,
    ToolCallRecord,
} from "@portable-devshell/shared";

import type { McpEndpointEnvironmentHandshake } from "../../instance/Gateway.js";

export interface McpEndpointWorkerPort {
    snapshot(): { ready?: boolean };
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(
        toolName: string,
        context: { requestId?: string; ctxId?: string },
    ): Promise<void>;
    prepareExtensionResource?(input: {
        collection: string;
        extensionId: string;
    }): Promise<{ directory: string }>;
    prepareWorkspace?(workspace: string): Promise<{
        projectMemoryAgentFile: string;
        projectMemoryDirectory: string;
        projectMemoryPresent?: boolean;
        temporaryDirectory: string;
        workspace: string;
    }>;
    readToolCalls?(query: ToolCallQuery): Promise<ToolCallRecord[]>;
    readAlerts(workspace: string): Promise<{
        advice: Array<{ code: string; text: string }>;
    }>;
    releaseAlerts?(workspace: string): Promise<void>;
    touchAlerts?(workspace: string): Promise<
        | void
        | {
              advice: Array<{ code: string; text: string }>;
          }
    >;
    touchTemporaryDirectory?(path: string): Promise<void>;
    readonly handshake?: McpEndpointEnvironmentHandshake;
}

export interface McpEndpointCallContext {
    principal: string;
    requestMeta?: Record<string, unknown>;
    requestId?: string;
}
