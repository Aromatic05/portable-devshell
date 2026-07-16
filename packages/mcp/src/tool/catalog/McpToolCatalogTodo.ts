import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export type McpToolCatalogTodoName = "todo_read" | "todo_write";

const todoItemSchema: JsonValue = {
    additionalProperties: false,
    allOf: [{
        if: {
            properties: { status: { enum: ["blocked", "failed"] } },
            required: ["status"]
        },
        then: { required: ["detail"] }
    }],
    properties: {
        content: {
            description: "Complete user-visible description of this todo item.",
            minLength: 1,
            type: "string"
        },
        detail: {
            description: "Additional status detail. Required when status is blocked or failed.",
            minLength: 1,
            type: "string"
        },
        id: {
            description: "Stable identifier unique within the complete todo list.",
            minLength: 1,
            type: "string"
        },
        status: {
            description: "Current item status.",
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

export class McpToolCatalogTodo {
    readonly #definitions: readonly ToolDefinition[] = [
        {
            requiredCapabilities: [],
            description: "Read the current todo plan. Use todo tools only for multi-step tasks.",
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
            requiredCapabilities: [],
            description: "This tool replaces the complete plan; it is not a patch. Always call todo_read first and pass its latest revision. Each item requires a unique id, content, and status. IDs must be unique. status must be one of pending | in_progress | blocked | completed | failed | cancelled. Allow at most one in_progress item; blocked and failed items require detail. title is optional. Update the plan promptly when progress changes.",
            group: "todo",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    revision: {
                        description: "Revision from the latest todo_read result.",
                        minimum: 0,
                        type: "integer"
                    },
                    title: {
                        description: "Optional title for the complete todo plan.",
                        minLength: 1,
                        type: "string"
                    },
                    todos: {
                        description: "The complete replacement list of todo items, not a partial update.",
                        contains: {
                            properties: { status: { const: "in_progress" } },
                            required: ["status"],
                            type: "object"
                        },
                        items: todoItemSchema,
                        maxContains: 1,
                        minContains: 0,
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

    isTodoTool(name: string): name is McpToolCatalogTodoName {
        return this.get(name) !== undefined;
    }

    list(): ToolDefinition[] {
        return this.#definitions.map((definition) => ({ ...definition }));
    }
}
