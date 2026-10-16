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
                        workspace: "Absolute workspace to attach or switch.",
                    },
                    title: "Create environment",
                },
            },
        },
        description:
            "Prepare and inspect the workspace environment for the current portable-devshell Context. This is the Context bootstrap tool: with workspace it creates or attaches a Context when needed, stable external bindings are reused automatically, and an expired Context lease is renewed without changing ctxId. Call it once before using other portable-devshell tools.",
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
                ...contextStateProperties,
                comment: {
                    description: "Actionable notes.",
                    items: { minLength: 1, type: "string" },
                    type: "array",
                },
                instance: { minLength: 1, type: "string" },
                memory: {
                    additionalProperties: false,
                    description: "Current Context Memory bound by devshell memory init/inherit; absent if unclaimed or temporarily unavailable. Check memoryStatus to distinguish these cases.",
                    properties: {
                        name: { minLength: 1, type: "string" },
                        directory: { minLength: 1, type: "string" },
                        mailbox: { minLength: 1, type: "string" },
                    },
                    required: ["name", "directory", "mailbox"],
                    type: "object",
                },
                memoryStatus: {
                    description: "Set to unavailable when the optional Comment Memory lookup fails or times out; the Context's existing Memory binding is unknown, not unclaimed.",
                    enum: ["unavailable"],
                    type: "string",
                },
                modelCommands: {
                    description: "Model commands offered by the enabled Extensions for this Instance.",
                    items: { minLength: 1, type: "string" },
                    type: "array",
                },
                platform: {
                    additionalProperties: false,
                    properties: {
                        arch: { minLength: 1, type: "string" },
                        distribution: {
                            additionalProperties: false,
                            properties: {
                                id: { minLength: 1, type: "string" },
                                name: { minLength: 1, type: "string" },
                                version: { minLength: 1, type: "string" },
                            },
                            required: ["id", "name"],
                            type: "object",
                        },
                        os: { minLength: 1, type: "string" },
                        packageManager: { minLength: 1, type: "string" },
                        shell: { minLength: 1, type: "string" },
                    },
                    required: ["arch", "os"],
                    type: "object",
                },
                projectMemoryAgentFile: { minLength: 1, type: "string" },
                projectMemoryDirectory: { minLength: 1, type: "string" },
                remoteEnvironment: {
                    additionalProperties: false,
                    properties: {
                        commands: {
                            items: { minLength: 1, type: "string" },
                            type: "array",
                        },
                    },
                    required: ["commands"],
                    type: "object",
                },
                skillsDirectory: { minLength: 1, type: "string" },
                temporaryDirectory: { minLength: 1, type: "string" },
                workspace: { minLength: 1, type: "string" },
            },
            required: [
                "expiresAt",
                "status",
                "instance",
                "workspace",
                "platform",
                "skillsDirectory",
                "temporaryDirectory",
            ],
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
                        command: "Use help to list current operations.",
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
                    minLength: 1,
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
