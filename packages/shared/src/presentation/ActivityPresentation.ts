import type { InstanceLogEntry } from "../protocol/instance/activity/Log.js";
import type {
    TodoReadResult,
    TodoTaskSummary,
} from "../protocol/instance/task/Todo.js";
import type { ToolCallRecord, ToolCallStatus } from "../protocol/tool/Call.js";
import type { JsonValue } from "../protocol/JsonValue.js";
const failedStatuses = new Set<ToolCallStatus>([
    "cancelled",
    "denied",
    "expired",
    "failed",
    "queueTimeout",
]);
const pendingStatuses = new Set<ToolCallStatus>([
    "pendingApproval",
    "queued",
    "running",
]);
export function resolveToolOutput(
    output: JsonValue | undefined,
    callId: string,
    logs: readonly Pick<InstanceLogEntry, "callId" | "message" | "stream">[],
): JsonValue | undefined {
    const linked = logs.filter((entry) => entry.callId === callId);
    const stdout = linked
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.message)
        .join("");
    const stderr = linked
        .filter((entry) => entry.stream === "stderr")
        .map((entry) => entry.message)
        .join("");
    if (stdout.length === 0 && stderr.length === 0) return output;
    const streams: Record<string, JsonValue> = {
        ...(stderr.length === 0 ? {} : { stderr }),
        ...(stdout.length === 0 ? {} : { stdout }),
    };
    if (output === undefined) return streams;
    if (typeof output !== "object" || output === null || Array.isArray(output))
        return output;
    return { ...streams, ...output };
}

export function toolCallOutcome(
    status: ToolCallStatus,
): "failure" | "pending" | "success" {
    if (status === "completed") return "success";
    if (pendingStatuses.has(status)) return "pending";
    return failedStatuses.has(status) ? "failure" : "failure";
}

export function projectTodoTaskSummaries(
    todo: TodoReadResult | undefined,
): TodoTaskSummary[] {
    if (todo === undefined) return [];
    const summaries = new Map(
        (todo.tasks ?? []).map((task) => [task.taskId, task]),
    );
    if (todo.taskId !== undefined) {
        const existing = summaries.get(todo.taskId);
        summaries.set(todo.taskId, {
            completed: todo.summary.completed,
            currentItem:
                todo.summary.currentItemId === undefined
                    ? undefined
                    : todo.items.find(
                          (item) => item.id === todo.summary.currentItemId,
                      )?.content,
            revision: todo.revision,
            status: activeTodoStatus(todo),
            taskId: todo.taskId,
            title: todo.title ?? todo.taskId,
            total: todo.summary.total,
            updatedAt: existing?.updatedAt ?? "-",
            ...(existing?.ctxId === undefined ? {} : { ctxId: existing.ctxId }),
        });
    }
    return [...summaries.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
    );
}

export function toolCallOutput(
    call: ToolCallRecord,
    logs: readonly InstanceLogEntry[],
): JsonValue | undefined {
    return resolveToolOutput(call.output, call.callId, logs);
}

function activeTodoStatus(todo: TodoReadResult): TodoTaskSummary["status"] {
    if (todo.items.some((item) => item.status === "failed")) return "failed";
    if (todo.items.some((item) => item.status === "blocked")) return "blocked";
    if (todo.items.some((item) => item.status === "in_progress"))
        return "in_progress";
    if (todo.summary.total > 0 && todo.summary.completed === todo.summary.total)
        return "completed";
    return todo.summary.total === 0 ? "none" : "pending";
}
