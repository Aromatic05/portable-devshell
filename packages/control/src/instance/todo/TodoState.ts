import { randomUUID } from "node:crypto";

import {
    createError,
    errorCodes,
    type ActiveTodoSummary,
    type InstanceEventType,
    type JsonValue,
    type TodoItem,
    type TodoComment,
    type TodoReadResult,
    type TodoState as SharedTodoState,
    type TodoStatus,
    type TodoSummary,
    type TodoTaskSummary,
    type TodoWriteInput,
    type ToolCallAssociation
} from "@portable-devshell/shared";

export interface TodoDocument {
    active: SharedTodoState[];
    archived: SharedTodoState[];
    comments: TodoComment[];
    version: 3;
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
        return { active: [], archived: [], comments: [], version: 3 };
    }

    normalizeDocument(value: unknown): TodoDocument {
        if (!isRecord(value) || value.version !== 3 || !Array.isArray(value.active) || !Array.isArray(value.archived) || !Array.isArray(value.comments)) {
            throw new Error("todo document must contain version=3 with active, archived, and comments arrays");
        }
        const active = value.active.map((entry) => this.#normalizeStoredState(entry));
        const titles = new Set(active.map((entry) => entry.title));
        if (titles.size !== active.length) throw new Error("active todo titles must be unique");
        return {
            active,
            archived: value.archived.map((entry) => this.#normalizeStoredState(entry)),
            comments: value.comments.map(normalizeComment),
            version: 3
        };
    }

    transition(document: TodoDocument, input: TodoWriteInput, ctxId: string): TodoTransition {
        const normalized = normalizeInput(input);
        const previousIndex = document.active.findIndex((entry) => entry.title === normalized.title);
        const previous = previousIndex === -1 ? undefined : document.active[previousIndex];
        const events: TodoTransition["events"] = [];
        const active = [...document.active];
        const archived = [...document.archived];
        let next: SharedTodoState;

        if (previous === undefined) {
            requireRevision(normalized.revision, 0);
            next = this.#createState(normalized, ctxId);
            active.push(next);
            events.push(todoEvent("todo.created", next));
        } else {
            requireRevision(normalized.revision, previous.revision);
            next = {
                ...previous,
                activeCtxId: ctxId,
                items: normalized.todos,
                revision: previous.revision + 1,
                updatedAt: this.#now()
            };
            events.push(todoEvent(
                !isCompleted(previous) && isCompleted(next) ? "todo.completed" : "todo.updated",
                next
            ));
            active[previousIndex] = next;
        }

        if (isTerminal(next)) {
            const archivedState = { ...next, archivedAt: this.#now() };
            const activeIndex = active.findIndex((entry) => entry.taskId === next.taskId);
            active.splice(activeIndex, 1);
            archived.push(archivedState);
            events.push(todoEvent("todo.archived", archivedState));
        }
        return { document: { active, archived, comments: document.comments, version: 3 }, events };
    }

    readResult(document: TodoDocument, title?: string): TodoReadResult {
        const tasks = this.#taskSummaries(document);
        if (title === undefined) {
            return { items: [], revision: 0, summary: { completed: 0, total: 0 }, tasks, comments: document.comments };
        }
        const state = document.active.find((entry) => entry.title === title);
        if (state === undefined) {
            return { items: [], revision: 0, summary: { completed: 0, total: 0 }, tasks, comments: document.comments };
        }
        return {
            items: state.items.map((item) => ({ ...item })),
            revision: state.revision,
            summary: summarize(state.items),
            taskId: state.taskId,
            title: state.title,
            tasks,
            comments: document.comments
        };
    }

    activeSummaries(document: TodoDocument): ActiveTodoSummary[] {
        return document.active.flatMap((state) => {
            const status = deriveStatus(state.items);
            if (status === "completed" || status === "cancelled" || status === "none") {
                return [];
            }
            const summary = summarize(state.items);
            const current = summary.currentItemId === undefined
                ? undefined
                : state.items.find((item) => item.id === summary.currentItemId);
            return [{
                completed: summary.completed,
                currentItem: current?.content,
                revision: state.revision,
                status,
                taskId: state.taskId,
                title: state.title,
                total: summary.total
            }];
        });
    }

    currentAssociation(document: TodoDocument, ctxId?: string): ToolCallAssociation | undefined {
        const active = document.active.find((entry) => entry.activeCtxId === ctxId);
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
        const title = requiredString(value.title, "title");
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
            title,
            updatedAt: requiredString(value.updatedAt, "updatedAt")
        };
        if (state.originInstance !== this.#instanceName) {
            throw new Error("todo state belongs to another instance");
        }
        return state;
    }

    #taskSummaries(document: TodoDocument): TodoTaskSummary[] {
        return document.active.map((state) => {
            const summary = summarize(state.items);
            const current = summary.currentItemId === undefined
                ? undefined
                : state.items.find((item) => item.id === summary.currentItemId);
            return {
                completed: summary.completed,
                ...(state.activeCtxId === undefined ? {} : { ctxId: state.activeCtxId }),
                currentItem: current?.content,
                revision: state.revision,
                status: deriveStatus(state.items),
                taskId: state.taskId,
                title: state.title,
                total: summary.total,
                updatedAt: state.updatedAt
            };
        });
    }
}

function normalizeInput(input: TodoWriteInput): TodoWriteInput {
    if (!isRecord(input)) throw invalidTodo("todo_write requires an object input");
    return {
        revision: requiredRevision(input.revision),
        title: normalizeText(input.title, "title"),
        todos: normalizeItems(input.todos)
    };
}

function normalizeComment(value: unknown): TodoComment {
    if (!isRecord(value)) throw new Error("todo comment must be an object");
    return {
        createdAt: requiredString(value.createdAt, "comment.createdAt"),
        ctxId: requiredString(value.ctxId, "comment.ctxId"),
        id: requiredString(value.id, "comment.id"),
        text: normalizeText(value.text, "comment.text")
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
