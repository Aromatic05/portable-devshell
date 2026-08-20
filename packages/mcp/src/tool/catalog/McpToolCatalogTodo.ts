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

const checkpointOutputSchema: JsonValue = {
    additionalProperties: false,
    properties: {
        blockers: { items: { minLength: 1, type: "string" }, type: "array" },
        next: { minLength: 1, type: "string" },
        summary: { minLength: 1, type: "string" },
        updatedAt: { minLength: 1, type: "string" },
    },
    required: ["summary", "updatedAt"],
    type: "object",
};

function todoTaskSummarySchema(includeCtxId: boolean): JsonValue {
    return {
        additionalProperties: false,
        properties: {
            checkpoint: checkpointOutputSchema,
            completed: { minimum: 0, type: "integer" },
            ...(includeCtxId ? { ctxId: { minLength: 1, type: "string" } } : {}),
            currentItem: { minLength: 1, type: "string" },
            pausedAt: { minLength: 1, type: "string" },
            revision: { minimum: 0, type: "integer" },
            status: {
                enum: ["pending", "in_progress", "blocked", "completed", "failed", "cancelled", "paused", "none"],
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
}

function outputSchema(includeCtxId: boolean): JsonValue {
    return {
        additionalProperties: false,
        properties: {
            cancelledAt: { minLength: 1, type: "string" },
            checkpoint: checkpointOutputSchema,
            items: { items: todoItemSchema, type: "array" },
            pausedAt: { minLength: 1, type: "string" },
            revision: { minimum: 0, type: "integer" },
            summary: todoSummarySchema,
            taskId: { minLength: 1, type: "string" },
            tasks: { items: todoTaskSummarySchema(includeCtxId), type: "array" },
            title: { minLength: 1, type: "string" }
        },
        required: ["items", "revision", "summary"],
        type: "object"
    };
}

export class McpToolCatalogTodo {
    readonly #definitions: readonly ToolDefinition[] = [
        {
            requiredCapabilities: [],
            description: "Read todo plans. Call with no selector to list live tasks and recover their stable taskId values. Read one task by taskId whenever it is known; title remains a compatibility selector. Use todo tools only for multi-step tasks.",
            group: "todo",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    taskId: {
                        description: "Stable task identifier returned by todo_read or todo_write. Prefer this selector once known.",
                        minLength: 1,
                        type: "string"
                    },
                    title: {
                        description: "Exact task title compatibility selector. Do not pass together with taskId.",
                        minLength: 1,
                        type: "string"
                    }
                },
                type: "object",
            },
            name: "todo_read",
            outputSchema: outputSchema(true),
        },
        {
            requiredCapabilities: [],
            description: "Replace one task's complete plan; this is not a patch. Create with a new immutable title and revision 0. After creation, preserve title and pass taskId on updates so task identity never depends on model memory of the title. Legacy title-only updates remain supported. Each item requires a unique id, content, and status. IDs must be unique. status must be one of pending | in_progress | blocked | completed | failed | cancelled. Allow at most one in_progress item; blocked and failed items require detail. checkpoint is optional durable handoff context; update it at meaningful progress boundaries with a concise summary and next action. Update the plan promptly when progress changes.",
            group: "todo",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    checkpoint: {
                        additionalProperties: false,
                        description: "Optional durable handoff checkpoint. Omit to preserve the previous checkpoint.",
                        properties: {
                            blockers: { items: { minLength: 1, type: "string" }, type: "array" },
                            next: { minLength: 1, type: "string" },
                            summary: { minLength: 1, type: "string" },
                        },
                        required: ["summary"],
                        type: "object",
                    },
                    revision: {
                        description: "Revision from the latest todo_read result.",
                        minimum: 0,
                        type: "integer"
                    },
                    taskId: {
                        description: "Stable task identifier returned when the task was created. Prefer this on every update; omit when creating revision 0.",
                        minLength: 1,
                        type: "string"
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
            outputSchema: outputSchema(true),
        },
    ];

    get(name: string): ToolDefinition | undefined {
        return this.#definitions.find((definition) => definition.name === name);
    }

    isTodoTool(name: string): name is McpToolCatalogTodoName {
        return this.get(name) !== undefined;
    }

    list(requiresExplicitContextId = true): ToolDefinition[] {
        return this.#definitions.map((definition) => ({
            ...definition,
            ...(definition.name === "todo_read" && !requiresExplicitContextId ? {
                description: "Read todo plans for the current host session. With no selector, list only tasks currently attached to this session. A known taskId may explicitly read a durable task from another Context for handoff. Use todo tools only for multi-step tasks.",
                inputSchema: {
                    additionalProperties: false,
                    properties: {
                        taskId: {
                            description: "Stable durable task identifier. Pass a known taskId to explicitly hand off a task from another Context.",
                            minLength: 1,
                            type: "string"
                        }
                    },
                    type: "object"
                }
            } : {}),
            ...(definition.name === "todo_write" && !requiresExplicitContextId ? {
                description: "Replace one task's complete plan; this is not a patch. Create a new task with revision 0 and no taskId. Every update to an existing durable task must pass its stable taskId; doing so explicitly attaches that task to the current host session. Preserve the immutable title. Each item requires a unique id, content, and status, with at most one in_progress item. checkpoint is optional durable handoff context and should be updated at meaningful progress boundaries."
            } : {}),
            outputSchema: outputSchema(requiresExplicitContextId),
        }));
    }
}
