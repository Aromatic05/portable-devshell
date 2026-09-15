import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderCliTopicUsage } from "../Usage.js";
import { parseContextMessageCommand } from "./Message.js";

export function parseContextCommand(argv: readonly string[]): CliParsedCommand {
    switch (argv[0]) {
        case "help": case "--help": case "-h": return expectNoExtra(argv, { kind: "help", topic: "context" });
        case "messages": case "send": return parseContextMessageCommand(argv);
        case "list": return expectNoExtra(argv, { kind: "context.list" });
        case "disable": case "renew":
            if (argv.length !== 2) throw CliRenderError.usage(`context ${argv[0]} requires <ctxId>`);
            return { ctxId: required(argv[1], "ctxId is required"), kind: argv[0] === "disable" ? "context.disable" : "context.renew" };
        default: throw CliRenderError.usage(`${`Unknown context command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("context")}`);
    }
}
function required(value: string | undefined, message: string): string { if (value) return value; throw CliRenderError.usage(message); }
function expectNoExtra<T extends CliParsedCommand>(argv: readonly string[], value: T): T { if (argv.length !== 1) throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`); return value; }

import type { CliDispatchContext } from "../Dispatch.js";
export async function executeContextLifecycle(command: CliParsedCommand, context: CliDispatchContext): Promise<boolean> {
    switch(command.kind){
        case "context.list": context.writeJson(await context.clients.context.list()); return true;
        case "context.disable": context.writeJson(await context.clients.context.disable(command.ctxId)); return true;
        case "context.renew": context.writeJson(await context.clients.context.renew(command.ctxId)); return true;
        default:return false;
    }
}
