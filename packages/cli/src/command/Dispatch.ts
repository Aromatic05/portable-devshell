import type { CliClients } from "../transport/Client.js";
import type { JsonValue } from "@portable-devshell/shared";
import { CliRenderError } from "../app/Failure.js";
import { negotiateCliControl } from "../transport/Client.js";
import type { CliLifecycleManagerLike } from "./control/service/Lifecycle.js";
import { executeControlLifecycle } from "./control/service/Lifecycle.js";
import { executeConfigCommand } from "./control/service/Config.js";
import { executeOverviewCommand } from "./control/service/Overview.js";
import { executeOAuthCommand } from "./control/OAuth.js";
import { executeContextLifecycle } from "./context/Lifecycle.js";
import { executeContextMessage } from "./context/Message.js";
import { executeDebugCommand } from "./context/Debug.js";
import { executeExtensionCommand } from "./extension/Command.js";
import { executeInstanceCreate } from "./instance/create/Command.js";
import { executeInit } from "./Init.js";
import { executeInstanceLifecycle } from "./instance/lifecycle/Command.js";
import { executeInstanceLogs } from "./instance/observe/Logs.js";
import { executeWatchStatus } from "./instance/observe/Status.js";
import { executeTodoCommand } from "./instance/Todo.js";
import { executeToolCommand } from "./instance/Tool.js";
import type { CliParsedCommand } from "./Parse.js";
import {
    renderCliTopicUsage,
    renderInstanceUsage,
    renderWatchUsage,
} from "./Usage.js";

export interface CliDispatchContext {
    clients: CliClients;
    controlNegotiated: boolean;
    followEventLimit?: number;
    outputFormat: CliOutputFormat;
    stdin: NodeJS.ReadableStream;
    stderr: { write(chunk: string): void };
    stdout: { write(chunk: string): void };
    lifecycle(): Promise<CliLifecycleManagerLike>;
    migrate(): Promise<{ changed: boolean; domains: readonly string[] }>;
    negotiate(): Promise<void>;
    readJson(source: string, label: string): Promise<JsonValue>;
    requireStreamingOutput(label: string): void;
    rootUsage(): Promise<string>;
    startTui(): Promise<void>;
    update(version?: string): Promise<void>;
    version(): string;
    writeJson(value: unknown): void;
    writeRecords(values: readonly unknown[], text: string): void;
    writeValue(value: unknown, text: string): void;
}

export type CliOutputFormat = "json" | "jsonl" | "text";

export async function dispatchCliCommand(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<void> {
    if (commandUsesControlClient(command) && !context.controlNegotiated)
        await context.negotiate();
    if (command.kind === "version") {
        const version = context.version();
        context.writeValue({ version }, `devshell ${version}\n`);
        return;
    }
    if (command.kind === "help") {
        context.stdout.write(
            `${command.topic === undefined ? await context.rootUsage() : renderCliTopicUsage(command.topic, command.command)}\n`,
        );
        return;
    }
    if (command.kind === "tui") {
        await context.startTui();
        return;
    }
    if (command.kind === "migrate") {
        const result = await context.migrate();
        context.writeValue(
            result,
            result.changed
                ? `Migrated: ${result.domains.join(", ")}\n`
                : "No migration required.\n",
        );
        return;
    }
    if (command.kind === "update") {
        if (context.outputFormat !== "text")
            throw CliRenderError.usage("update supports only text output");
        await context.update(command.version);
        return;
    }
    if (command.kind === "instance.help") {
        context.stdout.write(`${renderInstanceUsage(command.command)}\n`);
        return;
    }
    if (command.kind === "watch.help") {
        context.stdout.write(`${renderWatchUsage(command.command)}\n`);
        return;
    }
    const handlers = [
        executeInit,
        executeControlLifecycle,
        executeOverviewCommand,
        executeConfigCommand,
        executeOAuthCommand,
        executeContextLifecycle,
        executeContextMessage,
        executeDebugCommand,
        executeExtensionCommand,
        executeInstanceCreate,
        executeInstanceLifecycle,
        executeInstanceLogs,
        executeWatchStatus,
        executeTodoCommand,
        executeToolCommand,
    ];
    for (const handler of handlers) if (await handler(command, context)) return;
    throw new Error(`Unhandled CLI command: ${command.kind}`);
}

export function commandUsesControlClient(command: CliParsedCommand): boolean {
    if (
        command.kind === "overview" ||
        command.kind.startsWith("config.") ||
        command.kind.startsWith("approval.") ||
        command.kind.startsWith("oauth.") ||
        command.kind.startsWith("context.") ||
        command.kind.startsWith("debug.") ||
        command.kind === "cli.command" ||
        (command.kind.startsWith("extension.") &&
            command.kind !== "extension.help") ||
        command.kind.startsWith("tool.") ||
        command.kind.startsWith("todo.")
    )
        return true;
    return (
        (command.kind.startsWith("instance.") &&
            command.kind !== "instance.help") ||
        (command.kind.startsWith("watch.") && command.kind !== "watch.help")
    );
}

export function negotiateDispatchContext(
    clients: CliClients,
): () => Promise<void> {
    return async () => await negotiateCliControl(clients);
}
