import type { WorkerCommandInteractiveSession } from "@portable-devshell/core";
import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { CliCommandResult } from "@portable-devshell/extension/cli";
import {
    ControlError,
    createError,
    errorCodes,
    mergeComments,
    resolveErrorHints,
    resolveResultHints,
    toControlErrorBody,
    type InstanceCreateResult,
    type InstanceEvent,
    type InstanceListEntry,
    type InstanceLogEntry,
    type InstanceSnapshot,
    type JsonValue,
    type ReverseDeviceCodeResult,
    type TodoItem,
    type TodoReadResult,
    type TodoTaskSummary
} from "@portable-devshell/shared";

import type { InstanceCreatePort, InstanceEditorPort } from "../InstanceRouteModule.js";
import type { InstanceDescriptor } from "../InstanceDescriptor.js";
import type { InstanceRegistry } from "../registry/InstanceRegistry.js";
import type { ReverseCredentialService } from "../../reverse/credential/ReverseCredentialService.js";
import type { RuntimeSubscriptionManager } from "../../../instance/runtime/RuntimeSubscriptionManager.js";
import type {
    CliExtensionCommandInvocationContext,
    CliExtensionCommandProvider
} from "../../cli/CliExtensionCommandProvider.js";

export interface InstanceCliCommandProviderOptions {
    create: InstanceCreatePort;
    editor: InstanceEditorPort;
    instances: InstanceRegistry;
    reverse?: ReverseCredentialService;
    subscriptions: RuntimeSubscriptionManager;
}

export interface InstanceCliCreateResult extends InstanceCreateResult {
    reverseDeviceCode?: ReverseDeviceCodeResult;
}

export const instanceCliCommandDeclaration = Object.freeze({
    id: "instance",
    summary: "Inspect and manage portable-devshell instances",
    title: "Instance",
    usage: "instance <command>"
});

export function createInstanceCliCommandProvider(
    options: InstanceCliCommandProviderOptions
): CliExtensionCommandProvider {
    return Object.freeze({
        binding: async (
            argv: readonly string[],
            invocation: CliExtensionCommandInvocationContext
        ) => await executeInstanceCommand(options, argv, invocation),
        declaration: instanceCliCommandDeclaration,
        extensionId: "instance"
    });
}

export async function executeInstanceCommand(
    options: InstanceCliCommandProviderOptions,
    argv: readonly string[],
    invocation: CliExtensionCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    const [command, ...args] = argv;
    switch (command) {
        case "help":
        case "--help":
        case "-h":
            expect(args, 0, "instance help");
            return text(instanceUsage());
        case "create":
            requireLocalOwner(invocation, "instance create");
            return json(await createInstance(options, args));
        case "delete":
            requireLocalOwner(invocation, "instance delete");
            return json(await options.editor.deleteInstance({ instanceName: one(args, "instance delete <instance>") }));
        case "enable":
            requireLocalOwner(invocation, "instance enable");
            return json(await options.editor.enableInstance({ instanceName: one(args, "instance enable <instance>") }));
        case "disable":
            requireLocalOwner(invocation, "instance disable");
            return json(await options.editor.disableInstance({ instanceName: one(args, "instance disable <instance>") }));
        case "list":
            expect(args, 0, "instance list");
            return text(renderInstanceList(listInstances(options.instances)));
        case "status":
            return text(renderInstanceSnapshot(snapshot(requireInstance(options.instances, one(args, "instance status <instance>")))));
        case "start":
            requireLocalOwner(invocation, "instance start");
            return text(renderInstanceSnapshot(await startInstance(
                options.instances,
                requireInstance(options.instances, one(args, "instance start <instance>")),
                invocation
            )));
        case "stop":
            requireLocalOwner(invocation, "instance stop");
            return text(renderInstanceSnapshot(await stopInstance(
                options.instances,
                requireInstance(options.instances, one(args, "instance stop <instance>"))
            )));
        case "logs":
            return await logs(options, args, invocation);
        case "todo":
            return await todo(options, args, invocation);
        case "call":
            requireLocalOwner(invocation, "instance call");
            return text(await callTool(options, args, invocation));
        case "device-code":
            requireLocalOwner(invocation, "instance device-code");
            return text(renderReverseDeviceCode(await reverse(options).createDeviceCode(
                one(args, "instance device-code <instance>")
            )));
        case "rotate-token":
            requireLocalOwner(invocation, "instance rotate-token");
            return text(renderReverseTokenRotation(await reverse(options).rotateDeviceToken(
                one(args, "instance rotate-token <instance>")
            )));
        case "revoke-token":
            requireLocalOwner(invocation, "instance revoke-token");
            return text(renderReverseTokenRevocation(await reverse(options).revokeDeviceToken(
                one(args, "instance revoke-token <instance>")
            )));
        case undefined:
            throw usage(instanceUsage());
        default:
            throw usage(`Unknown instance command: ${command}\n\n${instanceUsage()}`);
    }
}

async function createInstance(
    options: InstanceCliCommandProviderOptions,
    args: readonly string[]
): Promise<InstanceCliCreateResult> {
    if (args.length !== 1) throw usage("instance create requires <json-draft> when invoked through cli.commands");
    const draft = parseJson(args[0]!, "instance create json-draft");
    if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
        throw usage("instance create json-draft must be a JSON object");
    }
    const result = await options.create.createInstance(draft);
    if ((draft as Record<string, JsonValue>).provider !== "reverse") return result;
    return {
        ...result,
        reverseDeviceCode: await reverse(options).createDeviceCode(result.name)
    };
}

async function startInstance(
    instances: InstanceRegistry,
    descriptor: InstanceDescriptor,
    invocation: CliExtensionCommandInvocationContext
): Promise<InstanceSnapshot> {
    if (!descriptor.enabled) {
        throw createError({
            code: errorCodes.instanceConflict,
            details: { instance: descriptor.name, operation: "start" },
            message: `Instance ${descriptor.name} is disabled.`,
            retryable: false
        });
    }
    const io = invocation.io;
    let session: WorkerCommandInteractiveSession | undefined;
    if (io !== undefined) {
        await io.requestInput({ raw: true });
        session = {
            readInput: async () => await io.readInput(),
            writeOutput: async (chunk) => await io.writeStderr(chunk)
        };
    }
    const result = await descriptor.worker.startInteractive(session);
    instances.markOwned(descriptor.name);
    return withTodoSummaries(result, descriptor);
}

async function stopInstance(instances: InstanceRegistry, descriptor: InstanceDescriptor): Promise<InstanceSnapshot> {
    const result = withTodoSummaries(await descriptor.worker.stop(), descriptor);
    instances.clearOwned(descriptor.name);
    if (!descriptor.enabled) instances.delete(descriptor.name);
    return result;
}

async function logs(
    options: InstanceCliCommandProviderOptions,
    args: readonly string[],
    invocation: CliExtensionCommandInvocationContext
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
    options: InstanceCliCommandProviderOptions,
    args: readonly string[],
    invocation: CliExtensionCommandInvocationContext
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

async function callTool(
    options: InstanceCliCommandProviderOptions,
    args: readonly string[],
    invocation: CliExtensionCommandInvocationContext
): Promise<string> {
    if (args.length !== 4) throw usage("instance call requires <instance> <workspace> <toolName> <jsonInput>");
    const [instance, workspace, toolName, inputText] = args as [string, string, string, string];
    const descriptor = requireInstance(options.instances, instance);
    const input = parseJson(inputText, "instance call jsonInput");
    let result: JsonValue;
    try {
        const raw = await descriptor.worker.callTool(toolName, input, {
            requestId: invocation.requestId,
            source: "cli",
            workspace
        }, invocation.signal);
        result = attachComments(raw, mergeComments([], resolveResultHints(toolName, raw)));
    } catch (error) {
        const failure = error instanceof ControlError ? error : createError({
            code: errorCodes.targetInvalid,
            message: error instanceof Error ? error.message : String(error),
            retryable: false
        });
        const body = toControlErrorBody(error);
        const hints = body === undefined ? [] : resolveErrorHints(toolName, body);
        result = {
            comment: mergeComments([], hints),
            error: { code: failure.code, message: failure.message, retryable: failure.retryable },
            result: null
        };
    }
    return `${renderToolCall(instance, toolName)}${renderToolResult(result)}`;
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

function reverse(options: InstanceCliCommandProviderOptions): ReverseCredentialService {
    if (options.reverse !== undefined) return options.reverse;
    throw createError({
        code: errorCodes.targetInvalid,
        message: "Reverse connection management is not available.",
        retryable: false
    });
}

function requireIo(
    invocation: CliExtensionCommandInvocationContext,
    command: string
): NonNullable<CliExtensionCommandInvocationContext["io"]> {
    if (invocation.io !== undefined) return invocation.io;
    throw createError({
        code: errorCodes.controlCliCommandFailed,
        message: `${command} requires streaming CLI I/O.`,
        retryable: false
    });
}

function requireLocalOwner(invocation: CliExtensionCommandInvocationContext, command: string): void {
    if (invocation.localOwner) return;
    throw createError({
        code: errorCodes.controlCliAccessDenied,
        message: `${command} is restricted to the local owner CLI.`,
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

function parseJson(textValue: string, label: string): JsonValue {
    try {
        return JSON.parse(textValue) as JsonValue;
    } catch (error) {
        throw usage(`${label} must be valid JSON`, error);
    }
}

function text(value: string): CliCommandResult {
    return { kind: "text", text: value };
}

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: JSON.parse(JSON.stringify(value)) as ExtensionJsonValue };
}

function usage(message: string, cause?: unknown): Error {
    return createError({
        code: "cli.usage",
        ...(cause === undefined ? {} : { cause }),
        message,
        retryable: false
    });
}

export function instanceUsage(): string {
    return [
        "Usage:",
        "  devshell instance create",
        "  devshell instance delete <instance>",
        "  devshell instance enable <instance>",
        "  devshell instance disable <instance>",
        "  devshell instance list",
        "  devshell instance status <instance>",
        "  devshell instance start <instance>",
        "  devshell instance stop <instance>",
        "  devshell instance logs <instance> [-f]",
        "  devshell instance todo <instance> [--follow|-f]",
        "  devshell instance call <instance> <workspace> <toolName> <jsonInput>",
        "  devshell instance device-code <instance>",
        "  devshell instance rotate-token <instance>",
        "  devshell instance revoke-token <instance>"
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

function renderReverseDeviceCode(result: ReverseDeviceCodeResult): string {
    return [
        `instance: ${result.instance}`,
        `device code: ${result.deviceCode}`,
        `expires: ${result.expiresAt}`,
        `enroll: devshell-worker enroll --controller ${result.controllerUrl} --device-code ${result.deviceCode}`,
        ""
    ].join("\n");
}

function renderReverseTokenRotation(result: { deviceToken: string; instance: string }): string {
    return [
        `instance: ${result.instance}`,
        "device token rotated",
        `new device token: ${result.deviceToken}`,
        "Update the remote worker credential before reconnecting.",
        ""
    ].join("\n");
}

function renderReverseTokenRevocation(result: { instance: string; revoked: true }): string {
    return `instance: ${result.instance}\ndevice token revoked\n`;
}

function renderToolCall(instance: string, toolName: string): string {
    return `instance: ${instance}\ntool: ${toolName}\n`;
}

function renderToolResult(result: JsonValue): string {
    if (!isCommandResult(result)) return `${JSON.stringify(result, null, 2)}\n`;
    const sections = [`exitCode: ${result.exitCode}`];
    if (result.stdout.length > 0) sections.push(`stdout:\n${result.stdout.replace(/\n$/u, "")}`);
    if (result.stderr.length > 0) sections.push(`stderr:\n${result.stderr.replace(/\n$/u, "")}`);
    return `${sections.join("\n")}\n`;
}

function isCommandResult(value: JsonValue): value is JsonValue & {
    exitCode: number | null;
    stderr: string;
    stdout: string;
} {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const candidate = value as Record<string, JsonValue>;
    return (typeof candidate.exitCode === "number" || candidate.exitCode === null)
        && typeof candidate.stdout === "string"
        && typeof candidate.stderr === "string";
}

function attachComments(result: JsonValue, comments: readonly string[]): JsonValue {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("Tool results must be objects when context comments are enabled.");
    }
    return { ...result, comment: [...comments] };
}
