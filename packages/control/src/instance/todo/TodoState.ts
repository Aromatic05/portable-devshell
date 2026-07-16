import { randomUUID } from "node:crypto";

import {
    createError,
    errorCodes,
    type ActiveTodoSummary,
    type InstanceEventType,
    type JsonValue,
    type TodoItem,
    type TodoReadResult,
    type TodoState as SharedTodoState,
    type TodoStatus,
    type TodoSummary,
    type TodoWriteInput,
    type ToolCallAssociation
} from "@portable-devshell/shared";

export interface TodoDocument {
    active?: SharedTodoState;
    archived: SharedTodoState[];
    version: 1;
}

export interface TodoTransition {
    document: TodoDocument;
    events: Array<{
        data: JsonValue;
        type: Extract<InstanceEventType, `todo.${string}`>;
    }>;
}

export class TodoState {
    readonly #instanceName: string;
    readonly #now: () => string;
    readonly #taskId: () => string;

    constructor(
        instanceName: string,
        options: { now?: () => string; taskId?: () => string } = {}
    ) {
        this.#instanceName = instanceName;
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#taskId = options.taskId ?? (() => `task-${randomUUID()}`);
    }

    emptyDocument(): TodoDocument {
        return { archived: [], version: 1 };
    }

    normalizeDocument(value: unknown): TodoDocument {
        if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.archived)) {
            throw new Error("todo document must contain version=1 and archived array");
        }
        return {
            ...(value.active === undefined ? {} : { active: this.#normalizeStoredState(value.active) }),
            archived: value.archived.map((entry) => this.#normalizeStoredState(entry)),
            version: 1
        };
    }

    transition(document: TodoDocument, input: TodoWriteInput, ctxId: string): TodoTransition {
        const normalized = normalizeInput(input);
        const previous = document.active;
        const events: TodoTransition["events"] = [];
        const archived = [...document.archived];
        let active: SharedTodoState;

        if (previous === undefined) {
            requireRevision(normalized.revision, 0);
            active = this.#createState(normalized, ctxId);
            events.push(todoEvent("todo.created", active));
        } else if (normalized.revision === 0 && isTerminal(previous)) {
            const archivedState = { ...previous, archivedAt: this.#now() };
            archived.push(archivedState);
            events.push(todoEvent("todo.archived", archivedState));
            active = this.#createState(normalized, ctxId);
            events.push(todoEvent("todo.created", active));
        } else {
            requireRevision(normalized.revision, previous.revision);
            active = {
                ...previous,
                activeCtxId: ctxId,
                items: normalized.todos,
                revision: previous.revision + 1,
                title: normalized.title,
                updatedAt: this.#now()
            };
            events.push(todoEvent(
                !isCompleted(previous) && isCompleted(active) ? "todo.completed" : "todo.updated",
                active
            ));
        }

        return { document: { active, archived, version: 1 }, events };
    }

    readResult(document: TodoDocument): TodoReadResult {
        const state = document.active;
        if (state === undefined) {
            return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
        }
        return {
            items: state.items.map((item) => ({ ...item })),
            revision: state.revision,
            summary: summarize(state.items),
            taskId: state.taskId,
            title: state.title
        };
    }

    activeSummary(document: TodoDocument): ActiveTodoSummary | undefined {
        const state = document.active;
        if (state === undefined) return undefined;
        const summary = summarize(state.items);
        const current = summary.currentItemId === undefined
            ? undefined
            : state.items.find((item) => item.id === summary.currentItemId);
        return {
            completed: summary.completed,
            currentItem: current?.content,
            revision: state.revision,
            status: deriveStatus(state.items),
            taskId: state.taskId,
            title: state.title,
            total: summary.total
        };
    }

    currentAssociation(document: TodoDocument): ToolCallAssociation | undefined {
        const active = document.active;
        const current = active?.items.find((item) => item.status === "in_progress");
        if (active === undefined || current === undefined) return undefined;
        return { taskId: active.taskId, todoItemId: current.id };
    }

    #createState(input: TodoWriteInput, ctxId: string): SharedTodoState {
        const now = this.#now();
        return {
            activeCtxId: ctxId,
            createdAt: now,
            createdByCtxId: ctxId,
            items: input.todos,
            originInstance: this.#instanceName,
            revision: 1,
            taskId: this.#taskId(),
            title: input.title,
            updatedAt: now
        };
    }

    #normalizeStoredState(value: unknown): SharedTodoState {
        if (!isRecord(value)) throw new Error("todo state must be an object");
        const activeCtxId = optionalString(value.activeCtxId ?? value.activeSessionId);
        const archivedAt = optionalString(value.archivedAt);
        const title = optionalString(value.title);
        const state: SharedTodoState = {
            ...(activeCtxId === undefined ? {} : { activeCtxId }),
            ...(archivedAt === undefined ? {} : { archivedAt }),
            createdAt: requiredString(value.createdAt, "createdAt"),
            createdByCtxId: requiredString(
                value.createdByCtxId ?? value.createdBySessionId,
                "createdByCtxId"
            ),
            items: normalizeItems(value.items),
            originInstance: requiredString(value.originInstance, "originInstance"),
            revision: requiredRevision(value.revision),
            taskId: requiredString(value.taskId, "taskId"),
            ...(title === undefined ? {} : { title }),
            updatedAt: requiredString(value.updatedAt, "updatedAt")
        };
        if (state.originInstance !== this.#instanceName) {
            throw new Error("todo state belongs to another instance");
        }
        return state;
    }
}

function normalizeInput(input: TodoWriteInput): TodoWriteInput {
    if (!isRecord(input)) throw invalidTodo("todo_write requires an object input");
    return {
        revision: requiredRevision(input.revision),
        title: input.title === undefined ? undefined : normalizeText(input.title, "title"),
        todos: normalizeItems(input.todos)
    };
}

function normalizeItems(value: unknown): TodoItem[] {
    if (!Array.isArray(value)) throw invalidTodo("todos must be an array");
    const ids = new Set<string>();
    let inProgress = 0;
    return value.map((entry, index) => {
        if (!isRecord(entry)) throw invalidTodo(`todos[${index}] must be an object`);
        const id = normalizeText(entry.id, `todos[${index}].id`);
        const content = normalizeText(entry.content, `todos[${index}].content`);
        const status = readStatus(entry.status, index);
        const detail = entry.detail === undefined
            ? undefined
            : normalizeText(entry.detail, `todos[${index}].detail`);
        if (ids.has(id)) throw invalidTodo(`todo id must be unique: ${id}`);
        ids.add(id);
        if (status === "in_progress" && ++inProgress > 1) {
            throw invalidTodo("at most one todo item may be in_progress");
        }
        if ((status === "blocked" || status === "failed") && detail === undefined) {
            throw invalidTodo(`${status} todo item ${id} requires detail`);
        }
        return { content, ...(detail === undefined ? {} : { detail }), id, status };
    });
}

function summarize(items: readonly TodoItem[]): TodoSummary {
    const included = items.filter((item) => item.status !== "cancelled");
    const current = items.find((item) => item.status === "in_progress");
    return {
        completed: included.filter((item) => item.status === "completed").length,
        ...(current === undefined ? {} : { currentItemId: current.id }),
        total: included.length
    };
}

function deriveStatus(items: readonly TodoItem[]): ActiveTodoSummary["status"] {
    if (items.some((item) => item.status === "in_progress")) return "in_progress";
    if (items.some((item) => item.status === "failed")) return "failed";
    if (items.some((item) => item.status === "blocked")) return "blocked";
    if (isCompletedItems(items)) return "completed";
    if (items.some((item) => item.status === "pending")) return "pending";
    if (items.length > 0 && items.every((item) => item.status === "cancelled")) return "cancelled";
    return "none";
}

function isCompleted(state: SharedTodoState): boolean {
    return isCompletedItems(state.items);
}

function isTerminal(state: SharedTodoState): boolean {
    return !state.items.some(
        (item) => item.status === "pending" || item.status === "in_progress" || item.status === "blocked"
    );
}

function isCompletedItems(items: readonly TodoItem[]): boolean {
    const included = items.filter((item) => item.status !== "cancelled");
    return included.length > 0 && included.every((item) => item.status === "completed");
}

function todoEvent(
    type: Extract<InstanceEventType, `todo.${string}`>,
    state: SharedTodoState
): TodoTransition["events"][number] {
    return {
        data: {
            revision: state.revision,
            summary: summarize(state.items),
            taskId: state.taskId,
            title: state.title
        } as unknown as JsonValue,
        type
    };
}

function requireRevision(actual: number, expected: number): void {
    if (actual !== expected) {
        throw createError({
            code: errorCodes.todoRevisionConflict,
            details: { actualRevision: actual, expectedRevision: expected },
            message: `Todo revision conflict: expected ${expected}, received ${actual}.`,
            retryable: true
        });
    }
}

function requiredRevision(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw invalidTodo("revision must be a non-negative safe integer");
    }
    return value;
}

function readStatus(value: unknown, index: number): TodoStatus {
    if (
        value === "pending" || value === "in_progress" || value === "blocked" ||
        value === "completed" || value === "failed" || value === "cancelled"
    ) return value;
    throw invalidTodo(`todos[${index}].status is invalid`);
}

function normalizeText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw invalidTodo(`${field} must be a non-empty string`);
    }
    return value.trim();
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function invalidTodo(message: string) {
    return createError({ code: errorCodes.todoInvalid, message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
