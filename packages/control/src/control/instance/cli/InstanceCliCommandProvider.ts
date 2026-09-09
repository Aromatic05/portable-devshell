import type { CliCommandResult } from "@portable-devshell/extension/cli";
import {
    createError,
    errorCodes,
    type InstanceListEntry,
    type InstanceLogEntry,
    type InstanceSnapshot,
    type TodoItem,
    type TodoReadResult,
    type TodoTaskSummary
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../InstanceDescriptor.js";
import type { InstanceRegistry } from "../registry/InstanceRegistry.js";
import type { RuntimeSubscriptionManager } from "../../../instance/runtime/RuntimeSubscriptionManager.js";
import type {
    CliExtensionCommandInvocationContext,
    CliExtensionCommandProvider,
    CliModelExtensionCommandInvocationContext
} from "../../cli/CliExtensionCommandProvider.js";

export interface InstanceModelCliCommandProviderOptions {
    instances: InstanceRegistry;
    subscriptions: RuntimeSubscriptionManager;
}

export const instanceModelCliCommandDeclaration = Object.freeze({
    id: "instance",
    summary: "Inspect portable-devshell instances",
    title: "Instance",
    usage: "instance <list|status|logs|todo>"
});

export function createInstanceModelCliCommandProvider(
    options: InstanceModelCliCommandProviderOptions
): CliExtensionCommandProvider {
    return Object.freeze({
        binding: async (argv: readonly string[], invocation: CliExtensionCommandInvocationContext) => {
            if (invocation.surface !== "model") {
                throw new TypeError("Instance model command provider received native invocation state.");
            }
            return await executeInstanceModelCommand(options, argv, invocation);
        },
        declaration: instanceModelCliCommandDeclaration,
        extensionId: "instance",
        surface: "model"
    });
}

export async function executeInstanceModelCommand(
    options: InstanceModelCliCommandProviderOptions,
    argv: readonly string[],
    invocation: CliModelExtensionCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    const [command, ...args] = argv;
    switch (command) {
        case "help":
        case "--help":
        case "-h":
            expect(args, 0, "instance help");
            return text(instanceModelUsage());
        case "list":
            expect(args, 0, "instance list");
            return text(renderInstanceList(listInstances(options.instances)));
        case "status":
            return text(renderInstanceSnapshot(
                snapshot(requireInstance(options.instances, one(args, "instance status <instance>")))
            ));
        case "logs":
            return await logs(options, args, invocation);
        case "todo":
            return await todo(options, args, invocation);
        case undefined:
            throw usage(instanceModelUsage());
        default:
            throw usage(`Unknown instance model command: ${command}\n\n${instanceModelUsage()}`);
    }
}

async function logs(
    options: InstanceModelCliCommandProviderOptions,
    args: readonly string[],
    invocation: CliModelExtensionCommandInvocationContext
): Promise<CliCommandResult> {
    const { follow, instance } = parseFollow(args, "instance logs <instance> [-f]");
    const descriptor = requireInstance(options.instances, instance);
    if (!follow) return text(renderInstanceLogs(await descriptor.worker.readLogs()));
    const io = requireIo(invocation, "instance logs -f");
    let nextLogSeq = 1;
    const emitNewLogs = async () => {
        const entries = await descriptor.worker.readLogs({ fromSeq: nextLogSeq });
        if (entries.length === 0) return;
        nextLogSeq = entries.at(-1)!.seq + 1;
        await io.writeStdout(renderInstanceLogs(entries));
    };
    const reload = async () => {
        const lastSeq = descriptor.worker.snapshot().lastSeq;
        await emitNewLogs();
        return lastSeq + 1;
    };
    const fromSeq = await reload();
    await options.subscriptions.watch(
        descriptor.name,
        descriptor.worker,
        fromSeq,
        invocation.signal,
        {
            eventFilter: (event) => event.type === "log.appended",
            onEvent: emitNewLogs,
            onGap: reload
        }
    );
    return text("");
}

async function todo(
    options: InstanceModelCliCommandProviderOptions,
    args: readonly string[],
    invocation: CliModelExtensionCommandInvocationContext
): Promise<CliCommandResult> {
    const { follow, instance } = parseFollow(args, "instance todo <instance> [--follow|-f]", true);
    const descriptor = requireInstance(options.instances, instance);
    const load = async () => {
        const lastSeq = descriptor.worker.snapshot().lastSeq;
        const value = await descriptor.todo.read();
        if (invocation.io !== undefined) await invocation.io.writeStdout(renderInstanceTodo(value));
        return { lastSeq, value };
    };
    if (!follow) return text(renderInstanceTodo((await load()).value));
    requireIo(invocation, "instance todo --follow");
    const initial = await load();
    await options.subscriptions.watch(
        descriptor.name,
        descriptor.worker,
        initial.lastSeq + 1,
        invocation.signal,
        {
            eventFilter: (event) => event.type.startsWith("todo."),
            onEvent: async () => {
                await load();
            },
            onGap: async () => (await load()).lastSeq + 1
        }
    );
    return text("");
}

function listInstances(instances: InstanceRegistry): InstanceListEntry[] {
    return instances.list().map((descriptor) => ({
        ...(descriptor.worker.handshake?.homeDirectory === undefined
            ? {}
            : { homeDirectory: descriptor.worker.handshake.homeDirectory }),
        mcpEnabled: descriptor.mcpEnabled,
        name: descriptor.name,
        snapshot: descriptor.worker.snapshot()
    }));
}

function snapshot(descriptor: InstanceDescriptor): InstanceSnapshot {
    return withTodoSummaries(descriptor.worker.snapshot(), descriptor);
}

function withTodoSummaries<T extends InstanceSnapshot>(value: T, descriptor: InstanceDescriptor): T {
    const activeTodos = descriptor.todo.summaries();
    return { ...value, ...(activeTodos.length === 0 ? {} : { activeTodos }) } as T;
}

function requireInstance(instances: InstanceRegistry, name: string): InstanceDescriptor {
    const descriptor = instances.get(name);
    if (descriptor !== undefined) return descriptor;
    throw createError({
        code: errorCodes.instanceMissing,
        details: { instance: name },
        message: `Instance ${name} was not found.`,
        retryable: false
    });
}

function requireIo(
    invocation: CliModelExtensionCommandInvocationContext,
    command: string
): NonNullable<CliModelExtensionCommandInvocationContext["io"]> {
    if (invocation.io !== undefined) return invocation.io;
    throw createError({
        code: errorCodes.controlCliCommandFailed,
        message: `${command} requires streaming CLI I/O.`,
        retryable: false
    });
}

function parseFollow(
    args: readonly string[],
    usageText: string,
    longFlag = false
): { follow: boolean; instance: string } {
    if (args.length < 1 || args.length > 2) throw usage(usageText);
    const instance = args[0]!;
    if (args.length === 1) return { follow: false, instance };
    const flag = args[1];
    if (flag !== "-f" && !(longFlag && flag === "--follow")) throw usage(usageText);
    return { follow: true, instance };
}

function one(args: readonly string[], usageText: string): string {
    if (args.length !== 1 || args[0]!.length === 0) throw usage(usageText);
    return args[0]!;
}

function expect(args: readonly string[], count: number, usageText: string): void {
    if (args.length !== count) throw usage(usageText);
}

function text(value: string): CliCommandResult {
    return { kind: "text", text: value };
}

function usage(message: string): Error {
    return createError({
        code: "cli.usage",
        message,
        retryable: false
    });
}

export function instanceModelUsage(): string {
    return [
        "Usage:",
        "  devshell instance list",
        "  devshell instance status <instance>",
        "  devshell instance logs <instance> [-f]",
        "  devshell instance todo <instance> [--follow|-f]"
    ].join("\n");
}

function renderInstanceList(instances: readonly InstanceListEntry[]): string {
    if (instances.length === 0) return "no instances\n";
    return `${instances.map((instance) =>
        `${instance.name}\t${instance.snapshot.status}\tready=${instance.snapshot.ready}`
    ).join("\n")}\n`;
}

function renderInstanceSnapshot(value: InstanceSnapshot): string {
    const lines = [
        `instance: ${value.name}`,
        `status: ${value.status}`,
        `ready: ${value.ready}`,
        `daemonState: ${value.daemonState}`,
        `connectionState: ${value.connectionState}`,
        `lastSeq: ${value.lastSeq}`
    ];
    if (value.lastErrorCode !== undefined || value.lastErrorMessage !== undefined) {
        lines.push(`lastErrorCode: ${value.lastErrorCode ?? "-"}`);
        lines.push(`lastErrorMessage: ${value.lastErrorMessage ?? "-"}`);
    }
    if (value.reverse !== undefined) {
        lines.push(`management: ${value.reverse.managementMode}`);
        lines.push(`reverseEnrollment: ${value.reverse.enrollmentState}`);
        lines.push(`reverseAvailability: ${value.reverse.availability}`);
        lines.push(`reverseTransport: ${value.reverse.transport ?? "-"}`);
        lines.push(`reverseGeneration: ${value.reverse.generation ?? "-"}`);
        lines.push(`reverseLastSeen: ${value.reverse.lastSeenAt ?? "-"}`);
        if (value.reverse.lastErrorCode !== undefined) {
            lines.push(`reverseLastErrorCode: ${value.reverse.lastErrorCode}`);
            lines.push(`reverseLastErrorMessage: ${value.reverse.lastErrorMessage ?? "-"}`);
        }
    }
    const activeTodos = value.activeTodos ?? [];
    lines.push(...(activeTodos.length === 0
        ? ["Todo: none"]
        : activeTodos.map((item) =>
            `Todo: ${item.completed}/${item.total} completed${item.currentItem === undefined ? "" : ` — ${item.currentItem}`}`
        )));
    return `${lines.join("\n")}\n`;
}

function renderInstanceLogs(entries: readonly InstanceLogEntry[]): string {
    if (entries.length === 0) return "";
    return `${entries.map((entry) =>
        `[${entry.seq}] ${entry.stream} ${entry.message.replace(/\n$/u, "")}`
    ).join("\n")}\n`;
}

const todoSymbols: Record<TodoItem["status"], string> = {
    blocked: "!",
    cancelled: "-",
    completed: "✓",
    failed: "×",
    in_progress: "●",
    pending: "○"
};

function renderInstanceTodo(value: TodoReadResult): string {
    if (value.taskId === undefined) {
        const tasks = value.tasks ?? [];
        if (tasks.length === 0) return "Todo: none\n";
        return `Tasks:\n${tasks.map(renderTaskSummary).join("\n")}\n`;
    }
    const current = value.items.find((item) => item.id === value.summary.currentItemId);
    const lines = [
        `Task: ${value.title ?? value.taskId}`,
        `Progress: ${value.summary.completed}/${value.summary.total}`,
        `Current: ${current?.content ?? "none"}`,
        "",
        ...value.items.map((item) => {
            const detail = item.detail === undefined ? "" : ` — ${item.detail}`;
            return `${todoSymbols[item.status]} ${item.content}${detail}`;
        })
    ];
    return `${lines.join("\n")}\n`;
}

function renderTaskSummary(task: TodoTaskSummary): string {
    const symbol = task.status === "none" ? "·" : task.status === "paused" ? "Ⅱ" : todoSymbols[task.status];
    const current = task.currentItem === undefined ? "" : ` — ${task.currentItem}`;
    return `${symbol} ${task.title} [${task.completed}/${task.total}]${current}`;
}
