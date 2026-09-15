import type { JsonValue } from "@portable-devshell/shared";
import { CliRenderError } from "../app/Failure.js";
import { parseConfigCommand } from "./control/Parse.js";
import { parseOAuthCommand } from "./control/OAuth.js";
import { parseContextCommand } from "./context/Lifecycle.js";
import { parseDebugCommand } from "./context/Debug.js";
import { parseExtensionCliCommand, parseExtensionCommand } from "./extension/Command.js";
import { parseInstanceCommand, parseWatchCommand } from "./instance/Parse.js";
import { parseTodoCommand } from "./instance/Todo.js";
import { parseApprovalCommand, parseToolCommand } from "./instance/Tool.js";
import type { CliHelpTopic } from "./Usage.js";

export type CliParsedCommand =
    | { kind: "help"; topic?: CliHelpTopic }
    | { kind: "version" }
    | { kind: "overview" }
    | { kind: "config.get" }
    | { draft: JsonValue; kind: "config.validate" }
    | { request: JsonValue; kind: "config.update" }
    | { kind: "approval.list"; instance: string }
    | { approvalId: string; decision: "approve" | "deny"; instance: string; kind: "approval.decide"; policyPatch?: JsonValue; reason?: string; remember?: boolean }
    | { approvalId: string; instance: string; kind: "approval.show" }
    | { after?: string; before?: string; callId?: string; instance: string; kind: "tool.calls"; limit?: number }
    | { kind: "oauth.status" }
    | { kind: "oauth.list" }
    | { approvalId: string; decision: "approve" | "deny"; kind: "oauth.decide" }
    | { kind: "context.list" }
    | { ctxId?: string; instance: string; kind: "context.messages" }
    | { ctxId: string; instance: string; kind: "context.send"; text: string }
    | { ctxId: string; kind: "context.disable" }
    | { ctxId: string; kind: "context.renew" }
    | { kind: "debug.targets" }
    | { kind: "debug.list" }
    | { ctxId: string; file: string; kind: "debug.load"; target: string; toolName?: string }
    | { kind: "debug.release"; patchId: string }
    | { kind: "debug.unload"; patchId: string }
    | { instance: string; kind: "todo.delete"; taskId: string }
    | { kind: "control.logs" }
    | { kind: "control.restart" }
    | { kind: "control.start" }
    | { kind: "control.status" }
    | { kind: "control.stop" }
    | { kind: "tui" }
    | { kind: "extension.help" }
    | { json: boolean; kind: "extension.list" }
    | { extensionId: string; kind: "extension.inspect" }
    | { extensionId: string; kind: "extension.enable" }
    | { extensionId: string; kind: "extension.disable" }
    | { extensionId: string; kind: "extension.reload" }
    | { kind: "extension.install"; source: string }
    | { extensionId: string; kind: "extension.remove"; purge: boolean }
    | { args: string[]; commandId: string; kind: "cli.command" }
    | { input: JsonValue; instance: string; kind: "instance.call"; toolName: string; workspace: string }
    | { kind: "instance.create" }
    | { instance: string; kind: "instance.delete" }
    | { instance: string; kind: "instance.enable" }
    | { instance: string; kind: "instance.disable" }
    | { kind: "instance.help" }
    | { instance: string; kind: "instance.deviceCode" }
    | { kind: "instance.list" }
    | { follow: boolean; instance: string; kind: "instance.logs" }
    | { follow: boolean; instance: string; kind: "instance.todo" }
    | { instance: string; kind: "instance.start" }
    | { instance: string; kind: "instance.status" }
    | { instance: string; kind: "instance.stop" }
    | { instance: string; kind: "instance.revokeToken" }
    | { instance: string; kind: "instance.rotateToken" }
    | { instance: string; kind: "watch.logs" }
    | { instance: string; kind: "watch.status" }
    | { kind: "watch.help" };

export class CliParser {
    parse(argv: readonly string[]): CliParsedCommand {
        if (argv.length === 0) return { kind: "control.status" };
        const trailing = trailingHelp(argv);
        if (trailing !== undefined) return trailing;
        switch (argv[0]) {
            case "--version": case "-V": return expectNoExtra(argv, { kind: "version" });
            case "help": case "--help": case "-h": return expectNoExtra(argv, { kind: "help" });
            case "start": return expectNoExtra(argv, { kind: "control.start" });
            case "restart": return expectNoExtra(argv, { kind: "control.restart" });
            case "stop": return expectNoExtra(argv, { kind: "control.stop" });
            case "status": return expectNoExtra(argv, { kind: "control.status" });
            case "logs": return expectNoExtra(argv, { kind: "control.logs" });
            case "overview": return expectNoExtra(argv, { kind: "overview" });
            case "config": return parseConfigCommand(argv.slice(1));
            case "approval": return parseApprovalCommand(argv.slice(1));
            case "tool": return parseToolCommand(argv.slice(1));
            case "todo": return parseTodoCommand(argv.slice(1));
            case "oauth": return parseOAuthCommand(argv.slice(1));
            case "context": return parseContextCommand(argv.slice(1));
            case "debug": return parseDebugCommand(argv.slice(1));
            case "tui": return expectNoExtra(argv, { kind: "tui" });
            case "extension": return parseExtensionCommand(argv.slice(1));
            case "instance": return parseInstanceCommand(argv.slice(1));
            case "watch": return parseWatchCommand(argv.slice(1));
            default: return parseExtensionCliCommand(argv);
        }
    }
}

function trailingHelp(argv: readonly string[]): CliParsedCommand | undefined {
    const last=argv.at(-1); if(argv.length<2||(last!=="--help"&&last!=="-h")) return undefined;
    switch(argv[0]) {
        case "extension": return {kind:"extension.help"};
        case "instance": return {kind:"instance.help"};
        case "watch": return {kind:"watch.help"};
        case "config": case "approval": case "oauth": case "context": case "debug": case "tool": case "todo": return {kind:"help",topic:argv[0]};
        case "start": case "restart": case "stop": case "status": case "logs": case "overview": case "tui": return {kind:"help"};
        default: return undefined;
    }
}
function expectNoExtra<T extends CliParsedCommand>(argv:readonly string[],value:T):T { if(argv.length!==1) throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`); return value; }
