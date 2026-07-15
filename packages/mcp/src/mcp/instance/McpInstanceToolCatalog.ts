import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export type McpInstanceToolName =
    | "instance_list"
    | "instance_status"
    | "instance_create"
    | "instance_start"
    | "instance_stop";

const emptyObjectSchema: JsonValue = {
    additionalProperties: false,
    properties: {},
    type: "object"
};

const instanceNameSchema: JsonValue = {
    additionalProperties: false,
    properties: {
        instance: {
            description: "Managed instance name returned by instance_list.",
            minLength: 1,
            type: "string"
        }
    },
    required: ["instance"],
    type: "object"
};

const genericOutputSchema: JsonValue = {
    type: "object"
};

export class McpInstanceToolCatalog {
    readonly #definitions: readonly ToolDefinition[] = [
        definition(
            "instance_list",
            "List managed instances and obtain names for cross-instance tool calls. Only use names returned here in another tool's instance field.",
            emptyObjectSchema
        ),
        definition(
            "instance_status",
            "Read the current status of one managed instance.",
            instanceNameSchema
        ),
        definition(
            "instance_create",
            "Create an SSH instance. Use only when explicitly requested by the user.",
            {
                additionalProperties: false,
                properties: {
                    host: {
                        description: "SSH host name, address, or SSH config host alias.",
                        minLength: 1,
                        type: "string"
                    },
                    identityFile: {
                        description: "Optional SSH identity file path.",
                        minLength: 1,
                        type: "string"
                    },
                    name: {
                        description: "New portable-devshell instance name.",
                        minLength: 1,
                        pattern: "^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$",
                        type: "string"
                    },
                    port: {
                        maximum: 65535,
                        minimum: 1,
                        type: "integer"
                    },
                    user: {
                        description: "Optional SSH user name.",
                        minLength: 1,
                        type: "string"
                    },
                    workspace: {
                        description: "Workspace path on the SSH host.",
                        minLength: 1,
                        type: "string"
                    }
                },
                required: ["name", "host", "workspace"],
                type: "object"
            }
        ),
        definition(
            "instance_start",
            "Start a managed instance. Use only when explicitly requested by the user.",
            instanceNameSchema
        ),
        definition(
            "instance_stop",
            "Stop a managed instance. Use only when explicitly requested by the user.",
            instanceNameSchema
        )
    ];

    list(): ToolDefinition[] {
        return this.#definitions.map((definition) => ({ ...definition }));
    }

    get(name: string): ToolDefinition | undefined {
        return this.#definitions.find((definition) => definition.name === name);
    }

    isInstanceTool(name: string): name is McpInstanceToolName {
        return this.get(name) !== undefined;
    }
}

function definition(name: McpInstanceToolName, description: string, inputSchema: JsonValue): ToolDefinition {
    return {
        requiredCapabilities: ["manage"],
        description,
        group: "instance",
        inputSchema,
        name,
        outputSchema: genericOutputSchema
    };
}
