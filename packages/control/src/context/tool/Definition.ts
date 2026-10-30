import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export const environmentInfoToolName = "environ_info" as const;
export const remoteEnvironmentToolName = "environ_remote" as const;

const contextStateProperties: Record<string, JsonValue> = {
    ctxId: {
        description:
            "Internal Context ID used when the endpoint exposes explicit Context identity.",
        minLength: 1,
        type: "string",
    },
    expiresAt: {
        description: "Current Context lease expiration time.",
        minLength: 1,
        type: "string",
    },
    status: {
        enum: ["active", "expired", "disabled"],
        type: "string",
    },
};

export function contextToolDefinitions(): readonly ToolDefinition[] {
    return [environmentInfoDefinition(), remoteEnvironmentDefinition()];
}

function environmentInfoDefinition(): ToolDefinition {
    return {
        _meta: {
            devshell: {
                mcp: {
                    annotations: {
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: false,
                        readOnlyHint: false,
                    },
                    inputHints: {
                        workspace: "Absolute workspace to attach or switch; if unknown, ask the user for its absolute path.",
                    },
                    title: "Create environment",
                },
            },
        },
        description:
            "Prepare the current Context before using other DevShell tools. If no Context is bound, use the workspace path already supplied by the user, or ask the user for its absolute path. Existing Contexts and expired leases can be reused.",
        group: "environ",
        inputSchema: {
            additionalProperties: false,
            properties: {
                workspace: {
                    description:
                        "Absolute workspace path. Required when the current Context has no workspace attachment; may switch the attachment for this instance.",
                    minLength: 1,
                    type: "string",
                },
            },
            type: "object",
        },
        name: environmentInfoToolName,
        outputSchema: {
            additionalProperties: false,
            properties: {
                comment: {
                    description: "Memory status and actionable workspace alerts.",
                    items: { minLength: 1, type: "string" },
                    type: "array",
                },
                // Explicit Context callers need this binding for subsequent calls.
                ctxId: { minLength: 1, type: "string" },
            },
            required: ["comment"],
            type: "object",
        },
        requiredCapabilities: [],
    };
}

function remoteEnvironmentDefinition(): ToolDefinition {
    return {
        _meta: {
            devshell: {
                mcp: {
                    annotations: {
                        destructiveHint: true,
                        idempotentHint: false,
                        openWorldHint: false,
                        readOnlyHint: false,
                    },
                    inputHints: {
                        command: "help (list operations), attach (requires handle; optional workspace), mask (requires handle; irreversible for this Context).",
                        handle: "Opaque instance handle from devshell instance list/status.",
                        workspace: "Absolute workspace for attach operations.",
                    },
                    title: "Manage remote environment",
                },
            },
        },
        description:
            "Manage remote environments for the current portable-devshell Context. Use command='help' when the current operations or arguments are unknown. Obtain opaque instance handles from model-facing devshell instance list or status. Masking is irreversible for the lifetime of this Context.",
        group: "environ",
        inputSchema: {
            additionalProperties: false,
            properties: {
                command: {
                    enum: ["help", "attach", "mask"],
                    type: "string",
                },
                handle: {
                    minLength: 1,
                    type: "string",
                },
                workspace: {
                    minLength: 1,
                    type: "string",
                },
            },
            required: ["command"],
            type: "object",
        },
        name: remoteEnvironmentToolName,
        outputSchema: {
            additionalProperties: false,
            properties: {
                ...contextStateProperties,
                command: { minLength: 1, type: "string" },
                details: {
                    additionalProperties: true,
                    type: "object",
                },
                message: { minLength: 1, type: "string" },
            },
            required: ["command", "message"],
            type: "object",
        },
        requiredCapabilities: [],
    };
}
