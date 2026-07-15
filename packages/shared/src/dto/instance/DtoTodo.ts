export type TodoStatus =
    | "pending"
    | "in_progress"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";

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
    currentItem?: string;
    revision: number;
    status: TodoStatus | "none";
    taskId: string;
    title?: string;
    total: number;
}

export interface TodoState {
    activeCtxId?: string;
    archivedAt?: string;
    createdAt: string;
    createdByCtxId: string;
    items: TodoItem[];
    originInstance: string;
    revision: number;
    taskId: string;
    title?: string;
    updatedAt: string;
}

export interface TodoReadResult {
    items: TodoItem[];
    revision: number;
    summary: TodoSummary;
    taskId?: string;
    title?: string;
}

export interface TodoWriteInput {
    revision: number;
    title?: string;
    todos: TodoItem[];
}

export interface TodoRpcEnvelope {
    lastSeq: number;
    todo: TodoReadResult;
}
