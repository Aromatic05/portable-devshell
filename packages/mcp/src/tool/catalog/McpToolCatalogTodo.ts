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

const todoSummarySchema: JsonValue = {
    additionalProperties: false,
    properties: {
        completed: { minimum: 0, type: "integer" },
        currentItemId: { minLength: 1, type: "string" },
        total: { minimum: 0, type: "integer" }
    },
    required: ["completed", "total"],
    type: "object"
};

const todoTaskSummarySchema: JsonValue = {
    additionalProperties: false,
    properties: {
        completed: { minimum: 0, type: "integer" },
        ctxId: { minLength: 1, type: "string" },
        currentItem: { minLength: 1, type: "string" },
        revision: { minimum: 0, type: "integer" },
        status: {
            enum: ["pending", "in_progress", "blocked", "completed", "failed", "cancelled", "none"],
            type: "string"
        },
        taskId: { minLength: 1, type: "string" },
        title: { minLength: 1, type: "string" },
        total: { minimum: 0, type: "integer" },
        updatedAt: { minLength: 1, type: "string" }
    },
    required: ["completed", "revision", "status", "taskId", "title", "total", "updatedAt"],
    type: "object"
};

const outputSchema: JsonValue = {
    additionalProperties: false,
    properties: {
        items: { items: todoItemSchema, type: "array" },
        revision: { minimum: 0, type: "integer" },
        summary: todoSummarySchema,
        taskId: { minLength: 1, type: "string" },
        tasks: { items: todoTaskSummarySchema, type: "array" },
        title: { minLength: 1, type: "string" }
    },
    required: ["items", "revision", "summary"],
    type: "object"
};

export class McpToolCatalogTodo {
    readonly #definitions: readonly ToolDefinition[] = [
        {
            requiredCapabilities: [],
            description: "Read todo plans. Call with no title to list all live task titles and summaries, which is the recovery entry point after context compression. Call again with a title to read that task's complete plan. Use todo tools only for multi-step tasks.",
            group: "todo",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    title: {
                        description: "Exact live task title. Omit to list live task titles and summaries.",
                        minLength: 1,
                        type: "string"
                    }
                },
                type: "object",
            },
            name: "todo_read",
            outputSchema,
        },
        {
            requiredCapabilities: [],
            description: "Replace one titled task's complete plan; this is not a patch. title is the immutable namespace and must be unique among live tasks. To create a task, use a new title with revision 0. To update one, first call todo_read with its title and pass its latest revision. After context compression, call todo_read without title to recover live titles before reading or updating a task. Each item requires a unique id, content, and status. IDs must be unique. status must be one of pending | in_progress | blocked | completed | failed | cancelled. Allow at most one in_progress item; blocked and failed items require detail. Update the plan promptly when progress changes.",
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
                        description: "Immutable task namespace, unique among live tasks.",
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
                required: ["revision", "title", "todos"],
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
