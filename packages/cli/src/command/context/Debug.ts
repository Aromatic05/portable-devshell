import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderCliTopicUsage } from "../Usage.js";

export function parseDebugCommand(argv: readonly string[]): CliParsedCommand {
    switch (argv[0]) {
        case "help": case "--help": case "-h": return expectNoExtra(argv, { kind: "help", topic: "debug" });
        case "targets": return expectNoExtra(argv, { kind: "debug.targets" });
        case "list": return expectNoExtra(argv, { kind: "debug.list" });
        case "load":
            if ((argv.length !== 5 && argv.length !== 7) || argv[3] !== "--ctx" || (argv.length === 7 && argv[5] !== "--tool")) throw CliRenderError.usage("debug load requires <target> <file> --ctx <ctxId> [--tool <toolName>]");
            return { ctxId: required(argv[4], "debug ctxId is required"), file: required(argv[2], "debug patch file is required"), kind: "debug.load", target: required(argv[1], "debug target is required"), ...(argv[6] === undefined ? {} : { toolName: required(argv[6], "debug toolName is required") }) };
        case "release": case "unload":
            if (argv.length !== 2) throw CliRenderError.usage(`debug ${argv[0]} requires <patchId>`);
            return { kind: argv[0] === "release" ? "debug.release" : "debug.unload", patchId: required(argv[1], "debug patchId is required") };
        default: throw CliRenderError.usage(`${`Unknown debug command: ${argv[0] ?? ""}`.trim()}\n\n${renderCliTopicUsage("debug")}`);
    }
}
function required(value: string | undefined, message: string): string { if (value) return value; throw CliRenderError.usage(message); }
function expectNoExtra<T extends CliParsedCommand>(argv: readonly string[], value: T): T { if (argv.length !== 1) throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`); return value; }

import { readFile } from "node:fs/promises";
import type { CliDispatchContext } from "../Dispatch.js";
export async function executeDebugCommand(command: CliParsedCommand, context: CliDispatchContext): Promise<boolean> {
    switch(command.kind){
        case "debug.targets": context.writeJson(await context.clients.debug.targets()); return true;
        case "debug.list": context.writeJson(await context.clients.debug.list()); return true;
        case "debug.load": context.writeJson(await context.clients.debug.load({scope:{ctxId:command.ctxId,...(command.toolName===undefined?{}:{toolName:command.toolName})},source:await readFile(command.file,"utf8"),target:command.target})); return true;
        case "debug.release": context.writeJson(await context.clients.debug.release(command.patchId)); return true;
        case "debug.unload": context.writeJson(await context.clients.debug.unload(command.patchId)); return true;
        default:return false;
    }
}
