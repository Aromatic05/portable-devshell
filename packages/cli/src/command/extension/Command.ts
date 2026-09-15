import { CliRenderError } from "../../app/Failure.js";
import type { CliParsedCommand } from "../Parse.js";

export function parseExtensionCommand(argv: readonly string[]): CliParsedCommand {
    if (argv.length === 0) return { kind: "extension.help" };
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") return expectNoExtra(argv, { kind: "extension.help" });
    switch (argv[0]) {
        case "list":
            if (argv.length === 1) return { json: false, kind: "extension.list" };
            if (argv.length === 2 && argv[1] === "--json") return { json: true, kind: "extension.list" };
            throw CliRenderError.usage("extension list accepts only [--json]");
        case "install": case "update":
            if (argv.length !== 2) throw CliRenderError.usage(`extension ${argv[0]} requires <bundle-or-directory>`);
            return { kind: "extension.install", source: required(argv[1], `extension ${argv[0]} source is required`) };
        case "remove": {
            if (argv.length < 2 || argv.length > 3) throw CliRenderError.usage("extension remove requires <extensionId> [--purge]");
            const purge = argv[2] === "--purge";
            if (argv[2] !== undefined && !purge) throw CliRenderError.usage(`Unknown extension remove option: ${argv[2]}`);
            return { extensionId: extensionId(argv[1]), kind: "extension.remove", purge };
        }
        case "inspect":
            if (argv.length !== 2) throw CliRenderError.usage("extension inspect requires <extensionId>");
            return { extensionId: extensionId(argv[1]), kind: "extension.inspect" };
        case "enable": case "disable": case "reload":
            if (argv.length !== 2) throw CliRenderError.usage(`extension ${argv[0]} requires <extensionId>`);
            return { extensionId: extensionId(argv[1]), kind: `extension.${argv[0]}` } as CliParsedCommand;
        default: throw CliRenderError.usage(`Unknown extension command: ${argv[0] ?? ""}`.trim());
    }
}

export function parseExtensionCliCommand(argv: readonly string[]): CliParsedCommand {
    return { args: [...argv.slice(1)], commandId: cliCommandId(argv[0]), kind: "cli.command" };
}
function cliCommandId(value: string | undefined): string { const id=required(value,"CLI command id is required"); if (/^[a-z][a-z0-9-]*$/u.test(id)) return id; throw CliRenderError.usage("CLI command id must match [a-z][a-z0-9-]*"); }
function extensionId(value: string | undefined): string { const id=required(value,"extension id is required"); if (/^[a-z][a-z0-9-]*$/u.test(id)) return id; throw CliRenderError.usage("extension id must match [a-z][a-z0-9-]*"); }
function required(value: string | undefined, message: string): string { if (value) return value; throw CliRenderError.usage(message); }
function expectNoExtra<T extends CliParsedCommand>(argv: readonly string[], value: T): T { if (argv.length !== 1) throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`); return value; }

import { resolve } from "node:path";
import type { CliDispatchContext } from "../Dispatch.js";
import { renderExtensionList, renderExtensionUsage } from "./Render.js";
export async function executeExtensionCommand(command: CliParsedCommand, context: CliDispatchContext): Promise<boolean> {
    switch(command.kind){
        case "extension.help": context.stdout.write(`${renderExtensionUsage()}\n`); return true;
        case "extension.list": { const records=await context.clients.extension.list(); if(command.json) context.writeJson(records); else context.stdout.write(renderExtensionList(records)); return true; }
        case "extension.install": context.writeJson(await context.clients.extension.install(resolve(command.source))); return true;
        case "extension.remove": context.writeJson(await context.clients.extension.remove(command.extensionId,command.purge)); return true;
        case "extension.inspect": context.writeJson(await context.clients.extension.get(command.extensionId)); return true;
        case "extension.enable": context.writeJson(await context.clients.extension.enable(command.extensionId)); return true;
        case "extension.disable": context.writeJson(await context.clients.extension.disable(command.extensionId)); return true;
        case "extension.reload": context.writeJson(await context.clients.extension.reload(command.extensionId)); return true;
        case "cli.command": { const result=await context.clients.cli.command(command.commandId,command.args,{relay:{input:context.stdin,stderr:context.stderr,stdout:context.stdout},workingDirectory:process.cwd()}); if(result.kind==="text"){const text=result.text??"";context.stdout.write(text.endsWith("\n")?text:`${text}\n`);}else context.writeJson(result.value??null); return true; }
        default:return false;
    }
}
