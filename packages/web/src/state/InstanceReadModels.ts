import type {
    ApprovalRequest,
    ContextMessageRecord,
    InstanceLogEntry,
    InstanceSnapshot,
    TodoReadResult,
    ToolCallRecord,
} from "@portable-devshell/shared/browser";

import type { WebClients } from "../client/WebClients.js";

export type InstanceReadModelKey =
    | "instance"
    | "logs"
    | "approvals"
    | "todos"
    | "toolCalls"
    | "contextMessages";

export interface InstanceReadModels {
    approvals?: ApprovalRequest[];
    contextMessages?: ContextMessageRecord[];
    failures: Partial<Record<InstanceReadModelKey, string>>;
    logs?: InstanceLogEntry[];
    snapshot?: InstanceSnapshot;
    todo?: TodoReadResult;
    toolCalls?: ToolCallRecord[];
}

export interface InstanceReadOptions {
    includeSnapshot?: boolean;
}

export async function readInstanceModels(
    clients: WebClients,
    name: string,
    options: InstanceReadOptions = {},
): Promise<InstanceReadModels> {
    const entries: Array<
        readonly [InstanceReadModelKey, Promise<unknown>]
    > = [
        ["logs", clients.runtime.readLogs(name, { limit: 100 })],
        ["approvals", clients.tool.listApprovals(name)],
        ["todos", clients.todo.get(name)],
        ["toolCalls", clients.tool.listCalls(name, { limit: 200 })],
        ["contextMessages", clients.contextMessage.list(name)],
    ];
    if (options.includeSnapshot === true) {
        entries.unshift(["instance", clients.runtime.refresh(name)]);
    }

    const settled = await Promise.allSettled(entries.map(([, request]) => request));
    const result: InstanceReadModels = { failures: {} };
    settled.forEach((entry, index) => {
        const key = entries[index]![0];
        if (entry.status === "rejected") {
            result.failures[key] = errorMessage(entry.reason);
            return;
        }
        switch (key) {
            case "instance":
                result.snapshot = (entry.value as { snapshot: InstanceSnapshot }).snapshot;
                break;
            case "logs":
                result.logs = (entry.value as InstanceLogEntry[]).slice(-100);
                break;
            case "approvals":
                result.approvals = entry.value as ApprovalRequest[];
                break;
            case "todos":
                result.todo = (entry.value as { todo: TodoReadResult }).todo;
                break;
            case "toolCalls":
                result.toolCalls = entry.value as ToolCallRecord[];
                break;
            case "contextMessages":
                result.contextMessages = entry.value as ContextMessageRecord[];
                break;
        }
    });
    return result;
}

export function instanceReadModelFailureKey(
    key: InstanceReadModelKey,
    name: string,
): string {
    return `${key}:${name}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
