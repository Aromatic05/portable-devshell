import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export const mcpContextAcquireToolName = "context_acquire" as const;
export const mcpContextRenewToolName = "context_renew" as const;
export const mcpEnvironmentToolName = "environ_info" as const;

export type McpToolCatalogEnvironmentName =
    | typeof mcpContextAcquireToolName
    | typeof mcpContextRenewToolName
    | typeof mcpEnvironmentToolName;

const contextIdentityProperties: Record<string, JsonValue> = {
    ctxId: {
        description:
            "Internal Context ID used by portable-devshell to anchor this Context.",
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

export function isMcpEnvironmentToolName(
    name: string,
): name is McpToolCatalogEnvironmentName {
    return (
        name === mcpContextAcquireToolName ||
        name === mcpContextRenewToolName ||
        name === mcpEnvironmentToolName
    );
}

export class McpToolCatalogEnvironment {
    readonly #definitions: readonly ToolDefinition[] = [
        {
            description:
                "Acquire the portable-devshell Context for a workspace and return its internal ctxId. When a configured stable external identity such as OpenAI session metadata is already bound, this returns the same Context instead of replacing it; an existing workspace attachment is not switched implicitly. Active Contexts use sliding lease renewal; an expired binding keeps the same ctxId and must be renewed explicitly.",
            group: "environment",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    workspace: {
                        description:
                            "Absolute path to the workspace on the worker machine.",
                        minLength: 1,
                        type: "string",
                    },
                },
                required: ["workspace"],
                type: "object",
            },
            name: mcpContextAcquireToolName,
            outputSchema: {
                additionalProperties: false,
                properties: {
                    ...contextIdentityProperties,
                    instance: { minLength: 1, type: "string" },
                    workspace: { minLength: 1, type: "string" },
                },
                required: [
                    "ctxId",
                    "expiresAt",
                    "status",
                    "instance",
                    "workspace",
                ],
                type: "object",
            },
            requiredCapabilities: [],
        },
        {
            description:
                "Renew the same portable-devshell Context lease without changing ctxId. Pass ctxId explicitly, or omit it when the request has a configured stable external Context binding.",
            group: "environment",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    ctxId: {
                        description:
                            "Internal Context ID. Optional when a stable external Context binding identifies it.",
                        minLength: 1,
                        type: "string",
                    },
                },
                type: "object",
            },
            name: mcpContextRenewToolName,
            outputSchema: {
                additionalProperties: false,
                properties: contextIdentityProperties,
                required: ["ctxId", "expiresAt", "status"],
                type: "object",
            },
            requiredCapabilities: [],
        },
        {
            description:
                "Prepare and inspect the workspace environment attached to the current portable-devshell Context. Context identity is resolved independently from this tool; use context_acquire when starting a new Context. workspace remains accepted so existing clients can attach or switch the current instance workspace without losing ctxId.",
            group: "environment",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    ctxId: {
                        description:
                            "Internal Context ID. Optional when a stable external Context binding identifies it.",
                        minLength: 1,
                        type: "string",
                    },
                    workspace: {
                        description:
                            "Absolute workspace path. Optional when this Context already has a workspace attached to the current instance.",
                        minLength: 1,
                        type: "string",
                    },
                },
                type: "object",
            },
            name: mcpEnvironmentToolName,
            outputSchema: {
                additionalProperties: false,
                properties: {
                    ...contextIdentityProperties,
                    comment: {
                        description: "Actionable notes.",
                        items: { minLength: 1, type: "string" },
                        type: "array",
                    },
                    instance: { minLength: 1, type: "string" },
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
                    skillsDirectory: { minLength: 1, type: "string" },
                    temporaryDirectory: { minLength: 1, type: "string" },
                    workspace: { minLength: 1, type: "string" },
                },
                required: [
                    "ctxId",
                    "expiresAt",
                    "status",
                    "instance",
                    "workspace",
                    "platform",
                    "skillsDirectory",
                    "projectMemoryAgentFile",
                    "projectMemoryDirectory",
                    "temporaryDirectory",
                ],
                type: "object",
            },
            requiredCapabilities: [],
        },
    ];

    list(
        options: { requireExplicitContextId?: boolean } = {},
    ): ToolDefinition[] {
        return this.#definitions.map((definition) => {
            const cloned = structuredClone(definition);
            if (
                definition.name === mcpContextRenewToolName &&
                options.requireExplicitContextId === true
            ) {
                cloned.inputSchema = {
                    ...(cloned.inputSchema as Record<string, JsonValue>),
                    required: ["ctxId"],
                };
            }
            return cloned;
        });
    }
}
