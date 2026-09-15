import type { CliClients } from "../transport/Client.js";
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
import { executeInstanceLifecycle } from "./instance/lifecycle/Command.js";
import { executeInstanceLogs } from "./instance/observe/Logs.js";
import { executeWatchStatus } from "./instance/observe/Status.js";
import { executeTodoCommand } from "./instance/Todo.js";
import { executeToolCommand } from "./instance/Tool.js";
import type { CliParsedCommand } from "./Parse.js";
import { renderCliTopicUsage, renderInstanceUsage, renderWatchUsage } from "./Usage.js";

export interface CliDispatchContext {
    clients: CliClients;
    controlNegotiated: boolean;
    followEventLimit?: number;
    stdin: NodeJS.ReadableStream;
    stderr: { write(chunk: string): void };
    stdout: { write(chunk: string): void };
    lifecycle(): Promise<CliLifecycleManagerLike>;
    negotiate(): Promise<void>;
    rootUsage(): Promise<string>;
    startTui(): Promise<void>;
    version(): string;
    writeJson(value: unknown): void;
}

export async function dispatchCliCommand(command: CliParsedCommand, context: CliDispatchContext): Promise<void> {
    if(commandUsesControlClient(command)&&!context.controlNegotiated) await context.negotiate();
    if(command.kind==="version"){context.stdout.write(`devshell ${context.version()}\n`);return;}
    if(command.kind==="help"){context.stdout.write(`${command.topic===undefined?await context.rootUsage():renderCliTopicUsage(command.topic)}\n`);return;}
    if(command.kind==="tui"){await context.startTui();return;}
    if(command.kind==="instance.help"){context.stdout.write(`${renderInstanceUsage()}\n`);return;}
    if(command.kind==="watch.help"){context.stdout.write(`${renderWatchUsage()}\n`);return;}
    const handlers=[executeControlLifecycle,executeOverviewCommand,executeConfigCommand,executeOAuthCommand,executeContextLifecycle,executeContextMessage,executeDebugCommand,executeExtensionCommand,executeInstanceCreate,executeInstanceLifecycle,executeInstanceLogs,executeWatchStatus,executeTodoCommand,executeToolCommand];
    for(const handler of handlers) if(await handler(command,context)) return;
    throw new Error(`Unhandled CLI command: ${command.kind}`);
}

export function commandUsesControlClient(command: CliParsedCommand): boolean {
    if(command.kind==="overview"||command.kind.startsWith("config.")||command.kind.startsWith("approval.")||command.kind.startsWith("oauth.")||command.kind.startsWith("context.")||command.kind.startsWith("debug.")||command.kind==="cli.command"||(command.kind.startsWith("extension.")&&command.kind!=="extension.help")||command.kind.startsWith("tool.")||command.kind.startsWith("todo.")) return true;
    return (command.kind.startsWith("instance.")&&command.kind!=="instance.help")||(command.kind.startsWith("watch.")&&command.kind!=="watch.help");
}

export function negotiateDispatchContext(clients: CliClients): () => Promise<void> {
    return async()=>await negotiateCliControl(clients);
}
