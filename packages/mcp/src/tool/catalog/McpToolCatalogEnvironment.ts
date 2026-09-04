import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import { workspaceAppResourceUri } from "../../workspace/McpWorkspaceApp.js";

export const mcpEnvironmentToolName = "environ_info" as const;

export type McpToolCatalogEnvironmentName = typeof mcpEnvironmentToolName;

export interface McpToolCatalogEnvironmentListOptions {
    workspaceApp?: boolean;
}

const contextIdentityProperties: Record<string, JsonValue> = {
    ctxId: {
        description: "Internal Context ID used by portable-devshell to anchor this Context.",
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
    return name === mcpEnvironmentToolName;
}

export class McpToolCatalogEnvironment {
    readonly #definition: ToolDefinition = {
        description:
            "Prepare and inspect the workspace environment for the current portable-devshell Context. This is the single Context bootstrap tool: with workspace it creates or attaches a Context when needed, stable external session bindings are reused automatically, and an expired Context lease is renewed without changing ctxId. Call it once before using other portable-devshell tools. Pass ctxId only when explicitly selecting an existing Context.",
        group: "environ",
        inputSchema: {
            additionalProperties: false,
            properties: {
                ctxId: {
                    description: "Internal Context ID when explicitly selecting an existing Context.",
                    minLength: 1,
                    type: "string",
                },
                workspace: {
                    description:
                        "Absolute workspace path. Required when the current Context has no workspace attachment; may switch the attachment for this instance.",
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
                projectMemoryAgentFile: {
                    description: "Durable project memory to read before working. Omitted when a current worker confirms no memory exists yet.",
                    minLength: 1,
                    type: "string",
                },
                projectMemoryDirectory: {
                    description: "Directory for durable project memory. Omitted together with projectMemoryAgentFile when no memory exists yet.",
                    minLength: 1,
                    type: "string",
                },
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
                "temporaryDirectory",
            ],
            type: "object",
        },
        requiredCapabilities: [],
    };

    list(options: McpToolCatalogEnvironmentListOptions = {}): ToolDefinition[] {
        const definition = structuredClone(this.#definition);
        if (options.workspaceApp === true) {
            definition._meta = {
                ui: { resourceUri: workspaceAppResourceUri, visibility: ["model", "app"] },
                "ui/resourceUri": workspaceAppResourceUri,
                "openai/outputTemplate": workspaceAppResourceUri,
                "openai/widgetAccessible": true,
            };
            definition.description =
                "Prepare and inspect the workspace environment for the current portable-devshell Context; the same call also bootstraps the Live Workspace App. This is the single Context and Workspace bootstrap tool: with workspace it creates or attaches a Context when needed, stable external session bindings are reused automatically, and an expired Context lease is renewed without changing ctxId. Call it once before using other portable-devshell tools. Pass ctxId only when explicitly selecting an existing Context.";
        }
        return [definition];
    }
}
