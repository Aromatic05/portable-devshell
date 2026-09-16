import type { TodoReadResult } from "@portable-devshell/shared";

import type { CliClientTodo } from "../../transport/Client.js";
import { followCliCommandWatchStream } from "./observe/Stream.js";

export class CliCommandInstanceTodo {
    async execute(
        todoClient: CliClientTodo,
        instance: string,
        follow: boolean,
        onTodo: (todo: TodoReadResult) => Promise<void> | void,
        maxEvents?: number,
    ): Promise<void> {
        const load = async () => {
            const envelope = await todoClient.get(instance);
            await onTodo(envelope.todo);
            return envelope.lastSeq + 1;
        };
        if (!follow) {
            await load();
            return;
        }
        await followCliCommandWatchStream({
            loadFromSeq: load,
            maxEvents,
            async onEvent() {
                await onTodo((await todoClient.get(instance)).todo);
            },
            subscribe: (fromSeq) => todoClient.subscribe(instance, fromSeq),
        });
    }
}

import type { TodoItem, TodoTaskSummary } from "@portable-devshell/shared";

const symbols: Record<TodoItem["status"], string> = {
    blocked: "!",
    cancelled: "-",
    completed: "✓",
    failed: "×",
    in_progress: "●",
    pending: "○",
};

export function renderInstanceTodo(todo: TodoReadResult): string {
    if (todo.taskId === undefined) {
        const tasks = todo.tasks ?? [];
        if (tasks.length === 0) {
            return "Todo: none\n";
        }
        return `Tasks:\n${tasks.map(renderTaskSummary).join("\n")}\n`;
    }

    const current = todo.items.find(
        (item) => item.id === todo.summary.currentItemId,
    );
    const lines = [
        `Task: ${todo.title ?? todo.taskId}`,
        `Progress: ${todo.summary.completed}/${todo.summary.total}`,
        `Current: ${current?.content ?? "none"}`,
        "",
        ...todo.items.map(renderItem),
    ];
    return `${lines.join("\n")}\n`;
}

function renderTaskSummary(task: TodoTaskSummary): string {
    const symbol =
        task.status === "none"
            ? "·"
            : task.status === "paused"
              ? "Ⅱ"
              : symbols[task.status];
    const current =
        task.currentItem === undefined ? "" : ` — ${task.currentItem}`;
    return `${symbol} ${task.title} [${task.completed}/${task.total}]${current}`;
}

function renderItem(item: TodoItem): string {
    const detail = item.detail === undefined ? "" : ` — ${item.detail}`;
    return `${symbols[item.status]} ${item.content}${detail}`;
}

import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderCliTopicUsage } from "../Usage.js";

export function parseTodoCommand(argv: readonly string[]): CliParsedCommand {
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
        if (argv.length !== 1)
            throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`);
        return { kind: "help", topic: "todo" };
    }
    if (argv[0] !== "delete" || argv.length !== 3)
        throw CliRenderError.usage(
            `todo delete requires <instance> <taskId>\n\n${renderCliTopicUsage("todo")}`,
        );
    if (!argv[1] || !argv[2])
        throw CliRenderError.usage("todo delete requires <instance> <taskId>");
    return { instance: argv[1], kind: "todo.delete", taskId: argv[2] };
}

import type { CliDispatchContext } from "../Dispatch.js";
export async function executeTodoCommand(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    if (command.kind === "todo.delete") {
        context.writeJson(
            await context.clients.todo.delete(command.instance, command.taskId),
        );
        return true;
    }
    if (command.kind !== "instance.todo") return false;
    if (command.follow)
        context.requireStreamingOutput("instance todo --follow");
    await new CliCommandInstanceTodo().execute(
        context.clients.todo,
        command.instance,
        command.follow,
        async (todo) => context.writeValue(todo, renderInstanceTodo(todo)),
        context.followEventLimit,
    );
    return true;
}
