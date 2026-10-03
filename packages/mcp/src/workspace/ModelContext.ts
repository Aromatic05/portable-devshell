import type { JsonValue } from "@portable-devshell/shared";
import type {
    WorkspaceHostModelContext,
    WorkspaceSnapshot,
} from "./Contract.js";

export function workspaceModelContext(
    snapshot: WorkspaceSnapshot,
    domain: { goal?: unknown; tasks: unknown[]; background: unknown[] },
): WorkspaceHostModelContext {
    const state = {
        background: domain.background.flatMap((value) => {
            const item = record(value);
            return item === undefined
                ? []
                : [
                      compact({
                          detachedAt: item.detachedAt,
                          goalId: item.goalId,
                          kind: item.kind,
                          result: item.result,
                          status: item.status,
                          taskId: item.taskId,
                          tmuxTaskId:
                              item.kind === "tmux" ? item.targetId : undefined,
                      }),
                  ];
        }),
        ctxId: snapshot.ctxId,
        goal: domain.goal ?? null,
        instance: snapshot.instance,
        tasks: domain.tasks.flatMap((value) => {
            const task = record(value);
            return task === undefined
                ? []
                : [
                      compact({
                          checkpoint: task.checkpoint,
                          currentItem: task.currentItem,
                          status: task.status,
                          taskId: task.taskId,
                          title: task.title,
                      }),
                  ];
        }),
    } as unknown as JsonValue;
    return {
        content: [
            {
                type: "text",
                text: `portable-devshell durable Workspace state:\n${JSON.stringify(state, null, 2)}`,
            },
        ],
        structuredContent: { portableDevshellWorkspace: state },
    };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as T;
}
