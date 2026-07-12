import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export type McpTodoToolName = "todo_read" | "todo_write";

const todoItemSchema: JsonValue = {
    additionalProperties: false,
    properties: {
        content: { minLength: 1, type: "string" },
        detail: { minLength: 1, type: "string" },
        id: { minLength: 1, type: "string" },
        status: {
            enum: [
                "pending",
                "in_progress",
                "blocked",
                "completed",
                "failed",
                "cancelled",
            ],
            type: "string",
        },
    },
    required: ["id", "content", "status"],
    type: "object",
};

const outputSchema: JsonValue = { type: "object" };

export class McpTodoToolCatalog {
    readonly #definitions: readonly ToolDefinition[] = [
        {
            access: "read",
            description:
                "Read the complete active todo plan for the current task.",
            group: "todo",
            inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object",
            },
            name: "todo_read",
            outputSchema,
        },
        {
            access: "write",
            description:
                "Replace the complete active todo plan. Always read first and pass the current revision. Revision conflicts are never overwritten silently.",
            group: "todo",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    revision: { minimum: 0, type: "integer" },
                    title: { minLength: 1, type: "string" },
                    todos: {
                        items: todoItemSchema,
                        type: "array",
                    },
                },
                required: ["revision", "todos"],
                type: "object",
            },
            name: "todo_write",
            outputSchema,
        },
    ];

    get(name: string): ToolDefinition | undefined {
        return this.#definitions.find((definition) => definition.name === name);
    }

    isTodoTool(name: string): name is McpTodoToolName {
        return this.get(name) !== undefined;
    }

    list(): ToolDefinition[] {
        return this.#definitions.map((definition) => ({ ...definition }));
    }
}
