import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export type McpTodoToolName = "todo_read" | "todo_write";

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
            description: "Replace the entire todo plan; this is not a patch. Always call todo_read first and pass its current revision. Allow at most one in_progress item. blocked and failed items require detail. Update the plan promptly when progress changes.",
            group: "todo",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    revision: { minimum: 0, type: "integer" },
                    title: { minLength: 1, type: "string" },
                    todos: {
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

    isTodoTool(name: string): name is McpTodoToolName {
        return this.get(name) !== undefined;
    }

    list(): ToolDefinition[] {
        return this.#definitions.map((definition) => ({ ...definition }));
    }
}
