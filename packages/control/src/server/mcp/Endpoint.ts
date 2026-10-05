import type {
    McpAuthConfig,
    McpHostInstanceConfig,
} from "@portable-devshell/mcp";
import type { ControlMcpAuthConfig } from "@portable-devshell/shared";

import type { Instance } from "@portable-devshell/core";

export class McpEndpointFactory {
    map(
        descriptor: Instance,
        auth: ControlMcpAuthConfig = { mode: "none" },
        workspaceEnabled = true,
    ): McpHostInstanceConfig {
        return {
            auth: toMcpAuthConfig(auth),
            contextMode: descriptor.mcpContextMode ?? "explicit",
            name: descriptor.name,
            path: descriptor.mcpPath,
            worker: {
                snapshot: () => descriptor.worker.snapshot(),
                appendMcpSessionClosed: async (sessionId) => {
                    await descriptor.worker.appendControlEvent("mcp.sessionClosed", { sessionId });
                },
                appendMcpSessionOpened: async (sessionId) => {
                    await descriptor.worker.appendControlEvent("mcp.sessionOpened", { sessionId });
                },
                appendMcpToolCalled: async (toolName, context) => {
                    await descriptor.worker.appendControlEvent("mcp.toolCalled", {
                        toolName,
                        ...(context.ctxId === undefined ? {} : { ctxId: context.ctxId }),
                        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
                    });
                },
                prepareExtensionResource: (input) => descriptor.worker.prepareExtensionResource(input),
                prepareWorkspace: (workspace) => descriptor.worker.prepareWorkspace(workspace),
                readAlerts: (workspace) => descriptor.worker.readAlerts(workspace),
                releaseAlerts: (workspace) => descriptor.worker.releaseAlerts(workspace),
                touchAlerts: (workspace) => descriptor.worker.touchAlerts(workspace),
                touchTemporaryDirectory: (path) => descriptor.worker.touchTemporaryDirectory(path),
            },
            workspaceEnabled,
        };
    }
}

function toMcpAuthConfig(auth: ControlMcpAuthConfig): McpAuthConfig {
    if (auth.mode === "none") return { enabled: false, provider: "none" };
    if (auth.mode === "token")
        return { enabled: true, provider: "token", token: auth.token };
    return { enabled: true, provider: "oauth2", oauth2: auth.oauth2 };
}
