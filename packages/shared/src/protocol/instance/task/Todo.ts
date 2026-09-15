export const TODO_MAX_ARCHIVED = 256;
export const TODO_MAX_ITEMS = 100;
export const TODO_MAX_TEXT_LENGTH = 4_000;
export const TODO_MAX_TITLE_LENGTH = 256;
export const TODO_MAX_ID_LENGTH = 128;
export const TODO_MAX_CHECKPOINT_BLOCKERS = 32;

export type TodoStatus =
    | "pending"
    | "in_progress"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";

export type TodoTaskStatus = TodoStatus | "none" | "paused";
export type TodoTaskControlAction = "pause" | "resume" | "cancel";

export interface TodoCheckpointInput {
    blockers?: string[];
    next?: string;
    summary: string;
}

export interface TodoCheckpoint extends TodoCheckpointInput {
    updatedAt: string;
}

export interface TodoItem {
    content: string;
    detail?: string;
    id: string;
    status: TodoStatus;
}

export interface TodoSummary {
    completed: number;
    currentItemId?: string;
    total: number;
}

export interface ActiveTodoSummary {
    completed: number;
    checkpoint?: TodoCheckpoint;
    currentItem?: string;
    pausedAt?: string;
    revision: number;
    status: TodoTaskStatus;
    taskId: string;
    title: string;
    total: number;
}

export interface TodoState {
    activeCtxId?: string;
    archivedAt?: string;
    cancelledAt?: string;
    checkpoint?: TodoCheckpoint;
    createdAt: string;
    createdByCtxId: string;
    items: TodoItem[];
    originInstance: string;
    pausedAt?: string;
    revision: number;
    taskId: string;
    title: string;
    updatedAt: string;
}

export interface TodoReadResult {
    cancelledAt?: string;
    checkpoint?: TodoCheckpoint;
    items: TodoItem[];
    pausedAt?: string;
    revision: number;
    summary: TodoSummary;
    taskId?: string;
    title?: string;
    tasks?: TodoTaskSummary[];
}

export interface TodoReadInput {
    taskId?: string;
    title?: string;
}

export interface TodoTaskSummary extends ActiveTodoSummary {
    ctxId?: string;
    updatedAt: string;
}

export interface TodoWriteInput {
    checkpoint?: TodoCheckpointInput;
    revision: number;
    taskId?: string;
    title: string;
    todos: TodoItem[];
}

export interface TodoRpcEnvelope {
    lastSeq: number;
    todo: TodoReadResult;
}
