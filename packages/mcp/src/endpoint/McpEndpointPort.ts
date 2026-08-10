import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

import type { McpEndpointCatalogWorker } from "./McpEndpointCatalog.js";

export interface McpEndpointWorkerPort extends McpEndpointCatalogWorker {
    auditToolCall<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string) => Promise<T>,
        signal?: AbortSignal
    ): Promise<T>;
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(
        toolName: string,
        context: { requestId?: string; ctxId?: string }
    ): Promise<void>;
    callTool(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>
    ): Promise<JsonValue>;
    prepareWorkspace?(workspace: string): Promise<{
        projectMemoryAgentFile: string;
        projectMemoryDirectory: string;
        temporaryDirectory: string;
        workspace: string;
    }>;
    readAlerts(workspace: string): Promise<{
        advice: Array<{ code: string; text: string }>;
    }>;
    touchAlerts?(workspace: string): Promise<void>;
    touchTemporaryDirectory?(path: string): Promise<void>;
    readonly handshake?: McpEndpointEnvironmentHandshake;
    readonly workspacePath?: string;
}

export interface McpEndpointEnvironmentHandshake {
    instance: string;
    skillsDirectory: string;
    workspace: string;
    platform: {
        arch: string;
        distribution?: {
            id: string;
            name: string;
            version?: string;
        };
        os: string;
        packageManager?: string;
        shell?: {
            executable: string;
            kind: string;
            version: string;
        };
    };
}

export interface McpEndpointCallContext {
    principal: string;
    requestId?: string;
}
