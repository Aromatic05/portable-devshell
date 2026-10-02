// Interaction Context bounded-context error codes. These describe MCP Context
// lifecycle failures (expired/disabled/invalid/renewal/workspace). The values
// are the wire codes carried in RemoteErrorBody.code.

export const contextErrorCodes = {
    disabled: "mcp.contextDisabled",
    expired: "mcp.contextExpired",
    instanceMasked: "mcp.contextInstanceMasked",
    invalid: "mcp.contextInvalid",
    workspaceRequired: "mcp.contextWorkspaceRequired",
} as const;

export type ContextErrorCode =
    (typeof contextErrorCodes)[keyof typeof contextErrorCodes];
