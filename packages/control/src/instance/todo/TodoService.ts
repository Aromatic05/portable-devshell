import { randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    openSync,
    readFileSync,
} from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
    createError,
    errorCodes,
    type ActiveTodoSummary,
    type InstanceEventType,
    type JsonValue,
    type TodoItem,
    type TodoReadResult,
    type TodoState,
    type TodoStatus,
    type TodoSummary,
    type TodoWriteInput,
    type ToolCallAssociation,
} from "@portable-devshell/shared";

interface TodoPersistenceDocument {
    active?: TodoState;
    archived: TodoState[];
    version: 1;
}

export interface TodoServiceOptions {
    appendEvent(
        type: Extract<InstanceEventType, `todo.${string}`>,
        data: JsonValue,
    ): Promise<void>;
    filePath: string;
    instanceName: string;
}

export class TodoService {
    readonly #appendEvent: TodoServiceOptions["appendEvent"];
    readonly #filePath: string;
    readonly #instanceName: string;
    #document: TodoPersistenceDocument;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: TodoServiceOptions) {
        this.#appendEvent = options.appendEvent;
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#document = loadDocument(options.filePath, options.instanceName);
    }

    async read(): Promise<TodoReadResult> {
        await this.#operation;
        return toReadResult(this.#document.active);
    }

    summary(): ActiveTodoSummary | undefined {
        return this.#document.active === undefined
            ? undefined
            : toActiveSummary(this.#document.active);
    }

    currentAssociation(): ToolCallAssociation | undefined {
        const active = this.#document.active;
        const current = active?.items.find(
            (item) => item.status === "in_progress",
        );
        if (active === undefined || current === undefined) {
            return undefined;
        }
        return {
            taskId: active.taskId,
            todoItemId: current.id,
        };
    }

    async write(
        input: TodoWriteInput,
        ctxId: string,
    ): Promise<TodoReadResult> {
        return await this.#runExclusive(async () => {
            const normalized = normalizeInput(input);
            const previous = this.#document.active;
            const events: Array<{
                data: JsonValue;
                type: Extract<InstanceEventType, `todo.${string}`>;
            }> = [];
            const archived = [...this.#document.archived];
            let active: TodoState;

            if (previous === undefined) {
                requireRevision(normalized.revision, 0);
                active = createState(this.#instanceName, normalized, ctxId);
                events.push(todoEvent("todo.created", active));
            } else if (normalized.revision === 0 && isTerminal(previous)) {
                const archivedState = {
                    ...previous,
                    archivedAt: new Date().toISOString(),
                };
                archived.push(archivedState);
                events.push(todoEvent("todo.archived", archivedState));
                active = createState(this.#instanceName, normalized, ctxId);
                events.push(todoEvent("todo.created", active));
            } else {
                requireRevision(normalized.revision, previous.revision);
                const now = new Date().toISOString();
                active = {
                    ...previous,
                    activeCtxId: ctxId,
                    items: normalized.todos,
                    revision: previous.revision + 1,
                    title: normalized.title,
                    updatedAt: now,
                };
                events.push(
                    todoEvent(
                        !isCompleted(previous) && isCompleted(active)
                            ? "todo.completed"
                            : "todo.updated",
                        active,
                    ),
                );
            }

            const next: TodoPersistenceDocument = {
                active,
                archived,
                version: 1,
            };
            await persistDocument(this.#filePath, next);
            this.#document = next;

            for (const event of events) {
                await this.#appendEvent(event.type, event.data);
            }

            return toReadResult(active);
        });
    }

    async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#operation;
        let release!: () => void;
        this.#operation = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function loadDocument(
    filePath: string,
    instanceName: string,
): TodoPersistenceDocument {
    if (!existsSync(filePath)) {
        return { archived: [], version: 1 };
    }

    try {
        const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
        return normalizeDocument(value, instanceName);
    } catch (error) {
        throw createError({
            cause: error,
            code: errorCodes.todoInvalid,
            details: { filePath },
            message: `Todo state for ${instanceName} is invalid.`,
            retryable: false,
        });
    }
}

function normalizeDocument(
    value: unknown,
    instanceName: string,
): TodoPersistenceDocument {
    if (
        !isRecord(value) ||
        value.version !== 1 ||
        !Array.isArray(value.archived)
    ) {
        throw new Error(
            "todo document must contain version=1 and archived array",
        );
    }
    const archived = value.archived.map((entry) =>
        normalizeState(entry, instanceName),
    );
    const active =
        value.active === undefined
            ? undefined
            : normalizeState(value.active, instanceName);
    return { active, archived, version: 1 };
}

function normalizeState(value: unknown, instanceName: string): TodoState {
    if (!isRecord(value)) {
        throw new Error("todo state must be an object");
    }
    const items = normalizeItems(value.items);
    const state: TodoState = {
        activeCtxId: optionalString(value.activeCtxId ?? value.activeSessionId),
        archivedAt: optionalString(value.archivedAt),
        createdAt: requiredString(value.createdAt, "createdAt"),
        createdByCtxId: requiredString(
            value.createdByCtxId ?? value.createdBySessionId,
            "createdByCtxId",
        ),
        items,
        originInstance: requiredString(value.originInstance, "originInstance"),
        revision: requiredRevision(value.revision),
        taskId: requiredString(value.taskId, "taskId"),
        title: optionalString(value.title),
        updatedAt: requiredString(value.updatedAt, "updatedAt"),
    };
    if (state.originInstance !== instanceName) {
        throw new Error("todo state belongs to another instance");
    }
    return state;
}

function normalizeInput(input: TodoWriteInput): TodoWriteInput {
    if (!isRecord(input)) {
        throw invalid("todo_write requires an object input");
    }
    return {
        revision: requiredRevision(input.revision),
        title: normalizeOptionalText(input.title, "title"),
        todos: normalizeItems(input.todos),
    };
}

function normalizeItems(value: unknown): TodoItem[] {
    if (!Array.isArray(value)) {
        throw invalid("todos must be an array");
    }
    const ids = new Set<string>();
    let inProgress = 0;
    return value.map((entry, index) => {
        if (!isRecord(entry)) {
            throw invalid(`todos[${index}] must be an object`);
        }
        const id = normalizeRequiredText(entry.id, `todos[${index}].id`);
        const content = normalizeRequiredText(
            entry.content,
            `todos[${index}].content`,
        );
        const status = readStatus(entry.status, index);
        const detail = normalizeOptionalText(
            entry.detail,
            `todos[${index}].detail`,
        );
        if (ids.has(id)) {
            throw invalid(`todo id must be unique: ${id}`);
        }
        ids.add(id);
        if (status === "in_progress") {
            inProgress += 1;
            if (inProgress > 1) {
                throw invalid("at most one todo item may be in_progress");
            }
        }
        if (
            (status === "blocked" || status === "failed") &&
            detail === undefined
        ) {
            throw invalid(`${status} todo item ${id} requires detail`);
        }
        return {
            content,
            ...(detail === undefined ? {} : { detail }),
            id,
            status,
        };
    });
}

function createState(
    instanceName: string,
    input: TodoWriteInput,
    ctxId: string,
): TodoState {
    const now = new Date().toISOString();
    return {
        activeCtxId: ctxId,
        createdAt: now,
        createdByCtxId: ctxId,
        items: input.todos,
        originInstance: instanceName,
        revision: 1,
        taskId: `task-${randomUUID()}`,
        title: input.title,
        updatedAt: now,
    };
}

function toReadResult(state: TodoState | undefined): TodoReadResult {
    if (state === undefined) {
        return {
            items: [],
            revision: 0,
            summary: { completed: 0, total: 0 },
        };
    }
    return {
        items: state.items.map((item) => ({ ...item })),
        revision: state.revision,
        summary: summarize(state.items),
        taskId: state.taskId,
        title: state.title,
    };
}

function toActiveSummary(state: TodoState): ActiveTodoSummary {
    const summary = summarize(state.items);
    const current =
        summary.currentItemId === undefined
            ? undefined
            : state.items.find((item) => item.id === summary.currentItemId);
    return {
        completed: summary.completed,
        currentItem: current?.content,
        revision: state.revision,
        status: deriveStatus(state.items),
        taskId: state.taskId,
        title: state.title,
        total: summary.total,
    };
}

function summarize(items: readonly TodoItem[]): TodoSummary {
    const included = items.filter((item) => item.status !== "cancelled");
    const current = items.find((item) => item.status === "in_progress");
    return {
        completed: included.filter((item) => item.status === "completed")
            .length,
        ...(current === undefined ? {} : { currentItemId: current.id }),
        total: included.length,
    };
}

function deriveStatus(items: readonly TodoItem[]): ActiveTodoSummary["status"] {
    if (items.some((item) => item.status === "in_progress")) {
        return "in_progress";
    }
    if (items.some((item) => item.status === "failed")) {
        return "failed";
    }
    if (items.some((item) => item.status === "blocked")) {
        return "blocked";
    }
    if (isCompletedItems(items)) {
        return "completed";
    }
    if (items.some((item) => item.status === "pending")) {
        return "pending";
    }
    if (
        items.length > 0 &&
        items.every((item) => item.status === "cancelled")
    ) {
        return "cancelled";
    }
    return "none";
}

function isCompleted(state: TodoState): boolean {
    return isCompletedItems(state.items);
}

function isTerminal(state: TodoState): boolean {
    return !state.items.some(
        (item) =>
            item.status === "pending" ||
            item.status === "in_progress" ||
            item.status === "blocked",
    );
}

function isCompletedItems(items: readonly TodoItem[]): boolean {
    const included = items.filter((item) => item.status !== "cancelled");
    return (
        included.length > 0 &&
        included.every((item) => item.status === "completed")
    );
}

function todoEvent(
    type: Extract<InstanceEventType, `todo.${string}`>,
    state: TodoState,
) {
    return {
        data: {
            revision: state.revision,
            summary: summarize(state.items),
            taskId: state.taskId,
            title: state.title,
        } as unknown as JsonValue,
        type,
    };
}

async function persistDocument(
    filePath: string,
    document: TodoPersistenceDocument,
): Promise<void> {
    const directory = dirname(filePath);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const temporary = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(
                `${JSON.stringify(document, null, 2)}\n`,
                "utf8",
            );
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, filePath);
    } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
    const directoryFd = openSync(directory, "r");
    try {
        fsyncSync(directoryFd);
    } finally {
        closeSync(directoryFd);
    }
}

function requireRevision(actual: number, expected: number): void {
    if (actual !== expected) {
        throw createError({
            code: errorCodes.todoRevisionConflict,
            details: { actualRevision: actual, expectedRevision: expected },
            message: `Todo revision conflict: expected ${expected}, received ${actual}.`,
            retryable: true,
        });
    }
}

function requiredRevision(value: unknown): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        throw invalid("revision must be a non-negative safe integer");
    }
    return value;
}

function readStatus(value: unknown, index: number): TodoStatus {
    if (
        value === "pending" ||
        value === "in_progress" ||
        value === "blocked" ||
        value === "completed" ||
        value === "failed" ||
        value === "cancelled"
    ) {
        return value;
    }
    throw invalid(`todos[${index}].status is invalid`);
}

function normalizeRequiredText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw invalid(`${field} must be a non-empty string`);
    }
    return value.trim();
}

function normalizeOptionalText(
    value: unknown,
    field: string,
): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    return normalizeRequiredText(value, field);
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

function invalid(message: string) {
    return createError({
        code: errorCodes.todoInvalid,
        message,
        retryable: false,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
